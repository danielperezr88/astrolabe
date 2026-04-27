/**
 * Pipeline Phase: Route Detection
 *
 * Reads actual source files to detect API route definitions across common
 * web frameworks. Creates Route nodes with HANDLES_ROUTE edges (#137).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

export interface RoutesOutput {
  routeCount: number;
  frameworks: string[];
}

const FRAMEWORK_PATTERNS: Array<{ name: string; regex: RegExp; extract: (m: RegExpExecArray) => { method: string; path: string } }> = [
  { name: 'express', regex: /\b(app|router)\.(get|post|put|delete|patch|use)\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: m[2], path: m[3] }) },
  { name: 'fastapi', regex: /@\w+\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: m[1], path: m[2] }) },
  { name: 'flask', regex: /@\w+\.route\s*\(\s*['"]([^'"]+)['"](?:.|\n)*?methods\s*=\s*\[([^\]]+)\]/g, extract: (m) => ({ method: m[2]?.trim() ?? 'GET', path: m[1] }) },
  { name: 'laravel', regex: /\bRoute::(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: m[1], path: m[2] }) },
  { name: 'django', regex: /\bpath\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: 'ANY', path: m[1] }) },
  { name: 'nextjs', regex: /export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH)\b/g, extract: (m) => ({ method: m[1], path: '[inferred]' }) },
];

export const routesPhase: PhaseDefinition<RoutesOutput> = {
  name: 'routes',
  dependencies: ['parse-emit'],

  execute(context: PhaseContext): RoutesOutput {
    const { graph } = context;
    let routeCount = 0;
    const frameworks = new Set<string>();

    for (const node of graph.iterNodes()) {
      if (node.label !== 'File') continue;
      const fp = node.properties.filePath as string | undefined;
      if (!fp) continue;

      // Only scan files in route-like directories or with route-like names
      if (!/routes?[\/\\]/.test(fp) && !/api[\/\\]/.test(fp) && !/controller/i.test(fp) && !/handler/i.test(fp) && !/route\.(ts|js|py|php)$/i.test(fp)) continue;

      try {
        const content = readFileSync(join(context.repoPath, fp), 'utf-8');
        for (const fw of FRAMEWORK_PATTERNS) {
          let match;
          while ((match = fw.regex.exec(content)) !== null) {
            const { method, path } = fw.extract(match);
            const routeId = `route:${fp}:${method}:${path}`;
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

    return { routeCount, frameworks: Array.from(frameworks) };
  },
};
