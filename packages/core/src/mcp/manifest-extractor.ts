/**
 * Manifest Contract Extraction.
 *
 * Parses OpenAPI/Swagger specs, docker-compose files, and .proto files
 * for declarative contract references. These supplement source-code contracts
 * extracted by contracts.ts for cross-repo linking.
 *
 * Uses regex/string parsing — no external YAML/JSON parser dependency needed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathBasename } from '@astrolabe/shared';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ManifestContract {
  type: 'openapi' | 'docker-compose' | 'proto' | 'gateway';
  name: string;
  endpoints?: Array<{ method: string; path: string }>;
  services?: string[];
  package?: string;
  filePath: string;
}

// ── File matching helpers ──────────────────────────────────────────────────

const OPENAPI_FILENAMES = new Set([
  'openapi.yaml', 'openapi.yml', 'openapi.json',
  'swagger.yaml', 'swagger.yml', 'swagger.json',
]);

function isOpenApiFile(filePath: string): boolean {
  const base = pathBasename(filePath);
  return OPENAPI_FILENAMES.has(base);
}

function isDockerComposeFile(filePath: string): boolean {
  const base = pathBasename(filePath);
  return base === 'docker-compose.yaml' || base === 'docker-compose.yml';
}

function isProtoFile(filePath: string): boolean {
  return filePath.endsWith('.proto');
}

// ── OpenAPI / Swagger extraction ───────────────────────────────────────────

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];
const HTTP_METHODS_SET = new Set(HTTP_METHODS);

/**
 * Derive a meaningful name from the OpenAPI spec's `info.title` field.
 */
function deriveOpenApiName(content: string, filePath: string): string {
  // YAML: title: "My API"  or  title: My API
  const yamlTitle = content.match(/^\s*title\s*:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (yamlTitle) return yamlTitle[1].trim();
  // JSON: "title": "My API"
  const jsonTitle = content.match(/"title"\s*:\s*"([^"]+)"/);
  if (jsonTitle) return jsonTitle[1];
  return pathBasename(filePath);
}

/**
 * Extract HTTP endpoint contracts from an OpenAPI/Swagger spec.
 *
 * Uses line-by-line scanning for both YAML and JSON formats.
 * For JSON, attempts JSON.parse first; falls back to regex scanning.
 */
export function extractOpenApiContracts(content: string, filePath: string): ManifestContract[] {
  try {
    // Try JSON parse first (for .json files)
    if (filePath.endsWith('.json')) {
      const json = JSON.parse(content);
      return extractOpenApiFromParsed(json, filePath);
    }

    // YAML: line-by-line scanning
    return extractOpenApiYaml(content, filePath);
  } catch {
    // JSON parse failed or malformed content — try YAML scan as fallback
    try {
      return extractOpenApiYaml(content, filePath);
    } catch {
      return [];
    }
  }
}

function extractOpenApiFromParsed(spec: Record<string, unknown>, filePath: string): ManifestContract[] {
  const endpoints: Array<{ method: string; path: string }> = [];
  const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths || typeof paths !== 'object') return [];

  for (const [apiPath, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== 'object') continue;
    for (const method of Object.keys(methods)) {
      if (HTTP_METHODS_SET.has(method.toLowerCase())) {
        endpoints.push({ method: method.toUpperCase(), path: apiPath });
      }
    }
  }

  if (endpoints.length === 0) return [];

  const info = spec.info as Record<string, unknown> | undefined;
  const name = (info?.title as string) ?? pathBasename(filePath);
  return [{ type: 'openapi', name, endpoints, filePath }];
}

function extractOpenApiYaml(content: string, filePath: string): ManifestContract[] {
  const endpoints: Array<{ method: string; path: string }> = [];
  const lines = content.split('\n');
  let inPaths = false;
  let pathsIndent = -1;
  let currentPath: string | null = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Detect paths: section
    if (/^paths\s*:/.test(trimmed)) {
      inPaths = true;
      pathsIndent = indent;
      continue;
    }

    // Exit paths section when we hit a top-level key at same or lower indent
    if (inPaths && indent <= pathsIndent && /^\S/.test(line) && !/^paths\s*:/.test(trimmed)) {
      inPaths = false;
      currentPath = null;
      continue;
    }

    if (!inPaths) continue;

    // Detect path key (e.g., "  /pets:" or '  "/api/users":')
    const pathMatch = trimmed.match(/^(["']?)(\/[^"'\s:]+)\1\s*:/);
    if (pathMatch) {
      currentPath = pathMatch[2];
      continue;
    }

    // Detect HTTP method key under current path (e.g., "    get:" or '    "get":')
    if (currentPath) {
      const methodMatch = trimmed.match(/^(["']?)(get|post|put|delete|patch|head|options|trace)\1\s*:/i);
      if (methodMatch) {
        endpoints.push({ method: methodMatch[2].toUpperCase(), path: currentPath });
      }
    }
  }

  if (endpoints.length === 0) return [];

  const name = deriveOpenApiName(content, filePath);
  return [{ type: 'openapi', name, endpoints, filePath }];
}

// ── docker-compose extraction ──────────────────────────────────────────────

/**
 * Extract service contracts from a docker-compose file.
 *
 * Uses indentation-aware line scanning to only pick up top-level service keys
 * under the `services:` section.
 */
export function extractDockerComposeContracts(content: string, filePath: string): ManifestContract[] {
  try {
    const services: string[] = [];
    const lines = content.split('\n');
    let insideServices = false;
    let serviceIndent = -1;

    for (const line of lines) {
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;

      // Detect start of services section
      if (/^services\s*:/.test(trimmed)) {
        insideServices = true;
        serviceIndent = indent + 2; // service names are indented 2 more spaces
        continue;
      }

      // Detect end of services section: another top-level key at indent 0
      if (insideServices && indent === 0 && /^[a-zA-Z]/.test(trimmed)) {
        insideServices = false;
        continue;
      }

      // Only match keys at exactly the service indent level
      if (insideServices && indent === serviceIndent) {
        const svcMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:/);
        if (svcMatch) {
          services.push(svcMatch[1]);
        }
      }
    }

    if (services.length === 0) return [];

    const name = pathBasename(filePath);
    return [{ type: 'docker-compose', name, services, filePath }];
  } catch {
    return [];
  }
}

// ── .proto extraction ──────────────────────────────────────────────────────

/**
 * Extract a balanced `{ … }` section starting right after the opening brace.
 * Returns the substring up to and including the matching closing brace.
 */
function extractBalancedSection(content: string, startIdx: number): string {
  let depth = 1;
  let i = startIdx;
  const len = content.length;

  while (i < len) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }

  return content.slice(startIdx, Math.min(i + 1, len));
}

/**
 * Extract gRPC service and RPC method contracts from a .proto file.
 *
 * Parses `package`, `service`, and `rpc` declarations using regex.
 */
export function extractProtoContracts(content: string, filePath: string): ManifestContract[] {
  try {
    const contracts: ManifestContract[] = [];

    // Extract package name
    const packageMatch = content.match(/package\s+([a-zA-Z][a-zA-Z0-9_.]*)\s*;/);
    const packageName = packageMatch?.[1];

    // Extract service blocks
    const serviceRegex = /service\s+([a-zA-Z][a-zA-Z0-9_]*)\s*\{/g;
    let svcMatch: RegExpExecArray | null;

    while ((svcMatch = serviceRegex.exec(content)) !== null) {
      const serviceName = svcMatch[1];
      const blockStart = svcMatch.index + svcMatch[0].length;
      const block = extractBalancedSection(content, blockStart);

      // Extract rpc methods from the service block
      const endpoints: Array<{ method: string; path: string }> = [];
      const rpcRegex = /rpc\s+([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g;
      let rpcMatch: RegExpExecArray | null;
      // #468: Reset lastIndex to prevent missed RPC matches across service blocks
      rpcRegex.lastIndex = 0;
      while ((rpcMatch = rpcRegex.exec(block)) !== null) {
        endpoints.push({ method: rpcMatch[1], path: `/${packageName ?? ''}/${serviceName}/${rpcMatch[1]}` });
      }

      contracts.push({
        type: 'proto',
        name: serviceName,
        endpoints,
        package: packageName,
        filePath,
      });
    }

    return contracts;
  } catch {
    return [];
  }
}

// ── Top-level dispatcher ───────────────────────────────────────────────────

/**
 * Extract manifest contracts from a list of file paths.
 *
 * Reads each file from disk, determines its type, and delegates to the
 * appropriate extractor. Returns a flat array of all discovered contracts.
 */
export function extractManifestContracts(filePaths: string[], repoPath: string): ManifestContract[] {
  const results: ManifestContract[] = [];

  for (const fp of filePaths) {
    try {
      const fullPath = join(repoPath, fp);
      const content = readFileSync(fullPath, 'utf-8');

      if (isOpenApiFile(fp)) {
        results.push(...extractOpenApiContracts(content, fp));
      } else if (isDockerComposeFile(fp)) {
        results.push(...extractDockerComposeContracts(content, fp));
      } else if (isProtoFile(fp)) {
        results.push(...extractProtoContracts(content, fp));
      }
    } catch {
      // Skip files that can't be read — graceful degradation
    }
  }

  return results;
}
