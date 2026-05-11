/**
 * Pipeline Phase: Security Scan (#464)
 *
 * Detects secrets, credentials, and security-sensitive code patterns
 * in indexed code files. Scans all node types for:
 *
 * 1. Secret patterns (AWS keys, GitHub tokens, private keys, JWTs, etc.)
 * 2. Security-sensitive code categories (auth, crypto, SQL, file I/O, network)
 *
 * Tags matching nodes with _security metadata and produces a structured
 * findings report.
 *
 * Runs after core symbol emission so all nodes exist on the graph.
 */
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

// #464: Security finding produced by the scan phase
export interface SecurityFinding {
  type: 'secret' | 'security-pattern';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  message: string;
  nodeId: string;
  filePath: string;
  line?: number;
  details?: Record<string, unknown>;
}

// #464: Aggregated output from the security scan phase
export interface SecurityScanOutput {
  findings: SecurityFinding[];
  secretCount: number;
  securityPatternCount: number;
}

// #464: Secret patterns to detect in source code
const SECRET_PATTERNS = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/g, severity: 'critical' as const },
  { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"][A-Za-z0-9/+=]{40}['"]/gi, severity: 'critical' as const },
  { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, severity: 'critical' as const },
  { name: 'GitHub OAuth', pattern: /gho_[A-Za-z0-9]{36}/g, severity: 'critical' as const },
  { name: 'Slack Token', pattern: /xox[baprs]-[0-9]{10,}-[A-Za-z0-9]+/g, severity: 'high' as const },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, severity: 'critical' as const },
  { name: 'JWT', pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, severity: 'medium' as const },
  { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"][A-Za-z0-9]{20,}['"]/gi, severity: 'high' as const },
  { name: 'Generic Secret', pattern: /(?:secret|password|token)\s*[=:]\s*['"][A-Za-z0-9!@#$%^&*]{16,}['"]/gi, severity: 'high' as const },
  { name: 'Google API Key', pattern: /AIza[0-9A-Za-z_-]{35}/g, severity: 'high' as const },
  { name: 'Stripe Key', pattern: /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{24,}/g, severity: 'critical' as const },
];

// #464: Security-sensitive code pattern categories
const SECURITY_PATTERNS = [
  { category: 'auth', patterns: [/\b(?:login|authenticate|authorize|logout|session)\b/i], severity: 'medium' as const },
  { category: 'crypto', patterns: [/\b(?:encrypt|decrypt|hash|sign|verify|cipher|digest)\b/i], severity: 'medium' as const },
  { category: 'sql', patterns: [/\b(?:executeQuery|rawQuery|\.query\(|sql.*\+|SELECT.*FROM|INSERT.*INTO)\b/i], severity: 'high' as const },
  { category: 'file-io', patterns: [/\b(?:readFile|writeFile|unlink|rmdir|exec|spawn)\b/i], severity: 'low' as const },
  { category: 'network', patterns: [/\b(?:fetch|axios|http\.request|XMLHttpRequest|websocket)\b/i], severity: 'info' as const },
];

// #464: Severity ordering for threshold filtering
const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * #464: Check whether a severity level meets the minimum threshold.
 */
export function meetsSeverity(severity: string, threshold: string): boolean {
  return (SEVERITY_ORDER[severity] ?? 4) <= (SEVERITY_ORDER[threshold] ?? 4);
}

export const securityScanPhase: PhaseDefinition<SecurityScanOutput> = {
  name: 'security-scan',
  dependencies: ['parse-emit'],

  execute(context: PhaseContext): SecurityScanOutput {
    const { graph } = context;

    const findings: SecurityFinding[] = [];
    let secretCount = 0;
    let securityPatternCount = 0;

    for (const node of graph.iterNodes()) {
      const content = typeof node.properties.content === 'string' ? node.properties.content as string : '';
      const name = typeof node.properties.name === 'string' ? node.properties.name as string : '';
      const filePath = typeof node.properties.filePath === 'string' ? node.properties.filePath as string : '';
      const startLine = typeof node.properties.startLine === 'number' ? node.properties.startLine as number : undefined;

      if (!filePath) continue;

      // #464: Skip binary/non-code files
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      const binaryExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'zip', 'gz', 'tar', 'wasm']);
      if (binaryExtensions.has(ext)) continue;

      const nodeSecrets: Array<{ name: string; severity: string; line?: number }> = [];
      const nodeCategories: string[] = [];

      // #464: Scan for secret patterns in content
      if (content) {
        const contentLines = content.split('\n');

        for (const { name: patternName, pattern, severity } of SECRET_PATTERNS) {
          const regex = new RegExp(pattern.source, pattern.flags);
          // Search overall content for presence
          regex.lastIndex = 0;
          if (!regex.test(content)) continue;

          // Find line number by searching line-by-line
          let foundLine: number | undefined;
          for (let i = 0; i < contentLines.length; i++) {
            const lineRegex = new RegExp(pattern.source, pattern.flags);
            if (lineRegex.test(contentLines[i])) {
              foundLine = (startLine ?? 0) + i;
              break;
            }
          }

          secretCount++;
          nodeSecrets.push({ name: patternName, severity, line: foundLine });

          findings.push({
            type: 'secret',
            severity,
            category: 'secret',
            message: `Detected ${patternName} in ${node.label} "${name || node.id}"`,
            nodeId: node.id,
            filePath,
            line: foundLine,
            details: { patternName },
          });
        }
      }

      // #464: Scan for security-sensitive code patterns in name and content
      const textToScan = [name, content].filter(Boolean).join(' ');
      if (textToScan) {
        for (const { category, patterns, severity } of SECURITY_PATTERNS) {
          let matched = false;
          for (const pat of patterns) {
            const regex = new RegExp(pat.source, pat.flags);
            if (regex.test(textToScan)) {
              matched = true;
              break;
            }
          }
          if (!matched) continue;

          securityPatternCount++;
          if (!nodeCategories.includes(category)) nodeCategories.push(category);

          findings.push({
            type: 'security-pattern',
            severity,
            category,
            message: `Security-sensitive ${category} pattern in ${node.label} "${name || node.id}"`,
            nodeId: node.id,
            filePath,
            line: startLine,
          });
        }
      }

      // #464: Tag node with security metadata (idempotent — overwrites previous)
      if (nodeSecrets.length > 0 || nodeCategories.length > 0) {
        node.properties._security = {
          secrets: nodeSecrets,
          categories: nodeCategories,
        };
      }
    }

    return { findings, secretCount, securityPatternCount };
  },
};
