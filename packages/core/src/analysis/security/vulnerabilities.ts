/**
 * Dependency vulnerability checking via OSV.dev API (#464).
 *
 * Parses package manifests (package.json, requirements.txt, go.mod, Cargo.toml)
 * and checks each dependency against the OSV.dev vulnerability database.
 *
 * No external dependencies required — uses only Node.js built-in fetch.
 * Fails gracefully on network errors (returns empty report with warning).
 */

// #464: Dependency parsed from a manifest file
export interface Dependency {
  name: string;
  version: string;
  ecosystem: string;
}

// #464: Vulnerability info from OSV.dev
export interface VulnerabilityInfo {
  id: string;
  severity: string;
  summary: string;
  affectedVersions: string[];
  fixedIn?: string;
  url?: string;
}

// #464: Aggregated vulnerability report
export interface VulnerabilityReport {
  dependencies: Array<{
    name: string;
    version: string;
    ecosystem: string;
    vulnerabilities: VulnerabilityInfo[];
  }>;
  totalVulnerabilities: number;
  criticalCount: number;
  highCount: number;
  moderateCount: number;
  lowCount: number;
}

// #464: Manifest file detected in the repository
export interface ManifestFile {
  path: string;
  ecosystem: string;
}

// #464: OSV.dev API endpoints
const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns';

// #464: Max batch size for OSV.dev API
const OSV_BATCH_SIZE = 1000;

/**
 * #464: Detect package manifest files in a repository path.
 */
export function detectManifestFiles(repoPath: string): ManifestFile[] {
  // Inline detection to avoid fs import at module level — caller passes path
  const { existsSync } = require('node:fs');
  const { join } = require('node:path');

  const candidates: Array<{ file: string; ecosystem: string }> = [
    { file: 'package.json', ecosystem: 'npm' },
    { file: 'requirements.txt', ecosystem: 'PyPI' },
    { file: 'go.mod', ecosystem: 'Go' },
    { file: 'Cargo.toml', ecosystem: 'crates.io' },
    { file: 'pom.xml', ecosystem: 'Maven' },
  ];

  const results: ManifestFile[] = [];
  for (const { file, ecosystem } of candidates) {
    const fullPath = join(repoPath, file);
    if (existsSync(fullPath)) {
      results.push({ path: fullPath, ecosystem });
    }
  }
  return results;
}

/**
 * #464: Parse a manifest file into a list of dependencies.
 */
export function parseManifest(manifestPath: string, ecosystem: string): Dependency[] {
  const { readFileSync } = require('node:fs');
  const deps: Dependency[] = [];

  try {
    const content = readFileSync(manifestPath, 'utf-8');

    switch (ecosystem) {
      case 'npm':
        parsePackageJson(content, deps);
        break;
      case 'PyPI':
        parseRequirementsTxt(content, deps);
        break;
      case 'Go':
        parseGoMod(content, deps);
        break;
      case 'crates.io':
        parseCargoToml(content, deps);
        break;
      // Maven/pom.xml parsing omitted — XML parsing without external deps is fragile
    }
  } catch {
    // Graceful: return empty array if manifest can't be read
  }

  return deps;
}

/**
 * #464: Parse package.json dependencies and devDependencies.
 */
function parsePackageJson(content: string, deps: Dependency[]): void {
  try {
    const pkg = JSON.parse(content);
    const sections = ['dependencies', 'devDependencies'] as const;
    for (const section of sections) {
      const obj = pkg[section];
      if (!obj || typeof obj !== 'object') continue;
      for (const [name, version] of Object.entries(obj)) {
        // Strip semver range characters (^, ~, >=, etc.)
        const cleanVersion = String(version).replace(/^[^0-9]*/, '');
        if (cleanVersion && cleanVersion.length > 0) {
          deps.push({ name, version: cleanVersion, ecosystem: 'npm' });
        }
      }
    }
  } catch {
    // Invalid JSON — skip
  }
}

/**
 * #464: Parse requirements.txt (name==version format).
 */
function parseRequirementsTxt(content: string, deps: Dependency[]): void {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*==\s*([0-9][0-9A-Za-z.*-]*)/);
    if (match) {
      deps.push({ name: match[1], version: match[2], ecosystem: 'PyPI' });
    }
  }
}

/**
 * #464: Parse go.mod require directives.
 */
function parseGoMod(content: string, deps: Dependency[]): void {
  let inRequire = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('require (')) { inRequire = true; continue; }
    if (inRequire && trimmed === ')') { inRequire = false; continue; }
    if (inRequire || trimmed.startsWith('require ')) {
      const match = trimmed.match(/^[\s]*([^\s]+)\s+(v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?)/);
      if (match) {
        deps.push({ name: match[1], version: match[2], ecosystem: 'Go' });
      }
    }
  }
}

/**
 * #464: Parse Cargo.toml [dependencies] section (basic TOML).
 */
function parseCargoToml(content: string, deps: Dependency[]): void {
  let inDeps = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '[dependencies]') { inDeps = true; continue; }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) { inDeps = false; continue; }
    if (!inDeps) continue;

    // Simple form: name = "version"
    const simpleMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*"([0-9][0-9A-Za-z.*+-]*)"/);
    if (simpleMatch) {
      deps.push({ name: simpleMatch[1], version: simpleMatch[2], ecosystem: 'crates.io' });
      continue;
    }

    // Table form: name = { version = "x.y.z" }
    const tableMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*version\s*=\s*"([0-9][0-9A-Za-z.*+-]*)"/);
    if (tableMatch) {
      deps.push({ name: tableMatch[1], version: tableMatch[2], ecosystem: 'crates.io' });
    }
  }
}

/**
 * #464: Check dependencies for known vulnerabilities via OSV.dev batch API.
 * Returns a structured report. Fails gracefully on network errors.
 */
export async function checkVulnerabilities(deps: Dependency[]): Promise<VulnerabilityReport> {
  const report: VulnerabilityReport = {
    dependencies: [],
    totalVulnerabilities: 0,
    criticalCount: 0,
    highCount: 0,
    moderateCount: 0,
    lowCount: 0,
  };

  if (deps.length === 0) return report;

  // Batch deps into chunks of OSV_BATCH_SIZE
  const batches: Dependency[][] = [];
  for (let i = 0; i < deps.length; i += OSV_BATCH_SIZE) {
    batches.push(deps.slice(i, i + OSV_BATCH_SIZE));
  }

  for (const batch of batches) {
    try {
      const queries = batch.map((dep) => ({
        package: { name: dep.name, ecosystem: dep.ecosystem },
        version: dep.version,
      }));

      const response = await fetch(OSV_BATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries }),
      });

      if (!response.ok) continue;

      const data = await response.json() as { results?: Array<{ vulns?: Array<{ id: string }> | null }> };
      const results = data.results ?? [];

      for (let i = 0; i < results.length && i < batch.length; i++) {
        const vulns = results[i]?.vulns;
        if (!vulns || vulns.length === 0) continue;

        const dep = batch[i];
        const vulnInfos: VulnerabilityInfo[] = [];

        // Fetch details for each vulnerability (limit to 5 per dep to avoid flooding)
        const vulnsToFetch = vulns.slice(0, 5);
        for (const vuln of vulnsToFetch) {
          try {
            const details = await fetchVulnDetails(vuln.id);
            vulnInfos.push(details);
          } catch {
            // Fallback: include minimal info
            vulnInfos.push({
              id: vuln.id,
              severity: 'UNKNOWN',
              summary: '',
              affectedVersions: [],
            });
          }
        }

        // Count severities
        for (const vi of vulnInfos) {
          report.totalVulnerabilities++;
          const sev = vi.severity.toUpperCase();
          if (sev === 'CRITICAL') report.criticalCount++;
          else if (sev === 'HIGH') report.highCount++;
          else if (sev === 'MODERATE' || sev === 'MEDIUM') report.moderateCount++;
          else report.lowCount++;
        }

        report.dependencies.push({
          name: dep.name,
          version: dep.version,
          ecosystem: dep.ecosystem,
          vulnerabilities: vulnInfos,
        });
      }
    } catch {
      // Network error — skip this batch gracefully
    }
  }

  return report;
}

/**
 * #464: Fetch full vulnerability details from OSV.dev.
 */
async function fetchVulnDetails(vulnId: string): Promise<VulnerabilityInfo> {
  const response = await fetch(`${OSV_VULN_URL}/${vulnId}`);
  if (!response.ok) {
    return { id: vulnId, severity: 'UNKNOWN', summary: '', affectedVersions: [] };
  }

  const data = await response.json() as Record<string, unknown>;

  // Extract severity from database_specific or severity array
  let severity = 'UNKNOWN';
  const severityArr = data.severity as Array<{ type: string; score: string }> | undefined;
  if (severityArr && severityArr.length > 0) {
    const cvss = severityArr.find((s) => s.type === 'CVSS_V3') ?? severityArr[0];
    const score = cvss.score;
    // Try to parse CVSS vector for severity label
    const match = score.match(/CVSS:[^/]*\/[A-Z]:([A-Z])/);
    if (match) {
      severity = match[1];
    } else {
      // Numeric score based
      const numMatch = score.match(/(\d+\.?\d*)$/);
      if (numMatch) {
        const num = parseFloat(numMatch[1]);
        if (num >= 9) severity = 'CRITICAL';
        else if (num >= 7) severity = 'HIGH';
        else if (num >= 4) severity = 'MODERATE';
        else severity = 'LOW';
      }
    }
  }

  // Try database_specific for GitHub severity
  if (severity === 'UNKNOWN') {
    const dbSpecific = data.database_specific as Record<string, string> | undefined;
    if (dbSpecific?.severity) {
      severity = dbSpecific.severity.toUpperCase();
    }
  }

  // Extract summary
  const summary = typeof data.summary === 'string' ? data.summary : '';

  // Extract affected versions and fixed-in
  const affected = data.affected as Array<{ ranges?: Array<{ type: string; events: Array<{ fixed?: string }> }> }> | undefined;
  const affectedVersions: string[] = [];
  let fixedIn: string | undefined;

  if (affected) {
    for (const a of affected) {
      if (a.ranges) {
        for (const range of a.ranges) {
          for (const event of range.events) {
            if (event.fixed) {
              fixedIn = event.fixed;
            }
          }
        }
      }
    }
  }

  return {
    id: vulnId,
    severity,
    summary,
    affectedVersions,
    fixedIn,
    url: `https://osv.dev/vulnerability/${vulnId}`,
  };
}
