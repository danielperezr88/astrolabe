/**
 * Pipeline Phase: Route Detection
 *
 * Reads actual source files to detect API route definitions across common
 * web frameworks. Creates Route nodes with HANDLES_ROUTE edges (#137).
 * Also creates FETCHES edges from Function/Method nodes that make HTTP
 * client calls to registered Route nodes (#428).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

export interface RoutesOutput {
  routeCount: number;
  frameworks: string[];
  fetchesCount: number;
}

// ── HTTP client detection patterns ─────────────────────────────────────────

/** Patterns that indicate an HTTP client call in function body text. */
const HTTP_CLIENT_DETECT: RegExp[] = [
  /\bfetch\s*\(/,
  /\baxios\.(get|post|put|delete|patch|request)\s*\(/,
  /\bgot\.(get|post|put|delete|patch)\s*\(/,
  /\b(request|superagent)\s*\(/,
  /\b(httpClient|HttpClient|http\.request)\s*\(/,
];

/** Extracts relative URL strings (e.g. '/api/users') from source text. */
const URL_EXTRACT = /['"`](\/[^'"`\s]*)['"`]/g;

// ── URL ↔ route matching ───────────────────────────────────────────────────

/**
 * Check whether a concrete URL (e.g. `/users/123`) matches a route path
 * pattern (e.g. `/users/:id`).
 *
 * Matching rules:
 * - Exact string equality is a match.
 * - Parameterized segments (`:param`) match any single path segment.
 * - The number of segments must be equal.
 */
export function urlMatchesRoute(url: string, routePath: string): boolean {
  if (url === routePath) return true;
  const urlSegs = url.split('/').filter(Boolean);
  const routeSegs = routePath.split('/').filter(Boolean);
  if (urlSegs.length !== routeSegs.length) return false;
  for (let i = 0; i < routeSegs.length; i++) {
    if (routeSegs[i]!.startsWith(':')) continue;
    if (routeSegs[i] !== urlSegs[i]) return false;
  }
  return true;
}

const FRAMEWORK_PATTERNS: Array<{ name: string; regex: RegExp; extract: (m: RegExpExecArray) => { method: string; path: string } }> = [
  { name: 'express', regex: /\b(app|router)\.(get|post|put|delete|patch|use)\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: m[2], path: m[3] }) },
  { name: 'fastapi', regex: /@\w+\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: m[1], path: m[2] }) },
  // #196: Avoid catastrophic backtracking by keeping regex within decorator parens
  { name: 'flask', regex: /@\w+\.route\s*\(\s*['"]([^'"]+)['"][^)]*?(?:methods\s*=\s*\[([^\]]+)\])?/g, extract: (m) => ({ method: m[2]?.trim() ?? 'GET', path: m[1] }) },
  { name: 'laravel', regex: /\bRoute::(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: m[1], path: m[2] }) },
  { name: 'django', regex: /\bpath\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: 'ANY', path: m[1] }) },
  // #197: Support non-async, arrow functions, and const exports
  { name: 'nextjs', regex: /export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|DELETE|PATCH)\b/g, extract: (m) => ({ method: m[1], path: '[inferred]' }) },
];

export const routesPhase: PhaseDefinition<RoutesOutput> = {
  name: 'routes',
  dependencies: ['parse-emit'],

  async execute(context: PhaseContext): Promise<RoutesOutput> {
    const { graph } = context;
    let routeCount = 0;
    const frameworks = new Set<string>();

    // #280: Support incremental indexing — only process changed/added files
    const changedPaths = context.state.get('incremental:changedPaths') as Set<string> | undefined;

    for (const node of graph.iterNodes()) {
      if (node.label !== 'File') continue;
      const fp = node.properties.filePath as string | undefined;
      if (!fp) continue;
      if (changedPaths && !changedPaths.has(fp)) continue;

      // Scan related directories and common entry point files (#198)
      if (!/routes?[\/\\]/.test(fp) && !/api[\/\\]/.test(fp) && !/controller/i.test(fp) && !/handler/i.test(fp) && !/route\.(ts|js|py|php)$/i.test(fp) && !/\b(app|main|server|index)\.(ts|js|py|php)$/i.test(fp)) continue;

      try {
        const content = await readFile(join(context.repoPath, fp), 'utf-8');
        for (const fw of FRAMEWORK_PATTERNS) {
          let match;
          while ((match = fw.regex.exec(content)) !== null) {
            const { method, path } = fw.extract(match);
            // #297: Include framework name to prevent ID collision across detectors
        const routeId = `route:${fp}:${fw.name}:${method}:${path}`;
            if (graph.getNode(routeId)) continue;

            graph.addNode({
              id: routeId, label: 'Route',
              properties: { name: `${method} ${path}`, filePath: fp, method, path, framework: fw.name },
            });
            graph.addRelationship({
              id: `route:file:${routeId}:${node.id}`, sourceId: node.id, targetId: routeId,
              type: 'HANDLES_ROUTE', confidence: 0.7,
              reason: `Route detected by ${fw.name} pattern in ${fp}`,
            });
            routeCount++;
            frameworks.add(fw.name);
          }
        }
      } catch { /* skip unreadable */ }
    }

    // ── FETCHES edge creation (#428) ──────────────────────────────────────

    // Build a registry: route path → route node IDs
    const routeRegistry = new Map<string, string[]>();
    for (const node of graph.iterNodes()) {
      if (node.label !== 'Route') continue;
      const path = node.properties.path as string | undefined;
      if (!path) continue;
      const ids = routeRegistry.get(path);
      if (ids) ids.push(node.id);
      else routeRegistry.set(path, [node.id]);
    }

    // If no routes were detected, skip FETCHES scanning
    let fetchesCount = 0;
    if (routeRegistry.size > 0) {
      // Collect Function/Method nodes grouped by file for batched file reads
      const functionsByFile = new Map<string, Array<{ id: string; name: string; startLine: number; endLine: number }>>();
      for (const node of graph.iterNodes()) {
        if (node.label !== 'Function' && node.label !== 'Method') continue;
        const fp = node.properties.filePath as string | undefined;
        if (!fp) continue;
        const startLine = (node.properties.startLine as number) ?? 0;
        const endLine = (node.properties.endLine as number) ?? Infinity;
        const name = (node.properties.name as string) ?? '';
        const fns = functionsByFile.get(fp);
        if (fns) fns.push({ id: node.id, name, startLine, endLine });
        else functionsByFile.set(fp, [{ id: node.id, name, startLine, endLine }]);
      }

      for (const [fp, fns] of functionsByFile) {
        let content: string;
        try {
          content = await readFile(join(context.repoPath, fp), 'utf-8');
        } catch { continue; }

        const lines = content.split('\n');

        for (const fn of fns) {
          // Extract the function body from the file (1-indexed lines)
          const start = Math.max(0, fn.startLine - 1);
          const end = fn.endLine === Infinity ? lines.length : Math.min(lines.length, fn.endLine);
          const body = lines.slice(start, end).join('\n');

          // Check if this function contains any HTTP client call
          if (!HTTP_CLIENT_DETECT.some((re) => re.test(body))) continue;

          // Extract all URL strings from the body
          const urls = new Set<string>();
          let urlMatch: RegExpExecArray | null;
          URL_EXTRACT.lastIndex = 0;
          while ((urlMatch = URL_EXTRACT.exec(body)) !== null) {
            urls.add(urlMatch[1]!);
          }

          // Match URLs to registered routes and create FETCHES edges
          for (const url of urls) {
            for (const [routePath, routeIds] of routeRegistry) {
              if (!urlMatchesRoute(url, routePath)) continue;
              for (const routeId of routeIds) {
                const edgeId = `fetches:${fn.id}:${routeId}`;
                if (graph.getRelationship(edgeId)) continue;
                graph.addRelationship({
                  id: edgeId,
                  sourceId: fn.id,
                  targetId: routeId,
                  type: 'FETCHES',
                  confidence: 0.7,
                  reason: `HTTP client call to ${url} matches route ${routePath}`,
                });
                fetchesCount++;
              }
            }
          }
        }
      }
    }

    return { routeCount, frameworks: Array.from(frameworks), fetchesCount };
  },
};
