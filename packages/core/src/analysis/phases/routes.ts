/**
 * Pipeline Phase: Route Detection
 *
 * Detects API route definitions across common web frameworks and creates
 * Route nodes with HANDLES_ROUTE edges to their handler functions.
 *
 * Dependencies: parse-emit (needs symbol nodes)
 * Output: Route nodes + HANDLES_ROUTE edges
 */

import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

export interface RoutesOutput {
  routeCount: number;
  frameworks: string[];
}

const routePatterns: Array<{ regex: RegExp; framework: string; method: string; pathGroup: number; handlerGroup: number }> = [
  // Express: app.get('/path', handler) / router.get('/path', handler)
  { regex: /\b(app|router)\.(get|post|put|delete|patch|use)\s*\(\s*['"]([^'"]+)['"]/g, framework: 'express', method: '', pathGroup: 3, handlerGroup: 0 },
  // Flask: @app.route('/path', methods=[...])
  { regex: /@\w+\.route\s*\(\s*['"]([^'"]+)['"]/g, framework: 'flask', method: 'ANY', pathGroup: 1, handlerGroup: 0 },
  // FastAPI: @app.get('/path') / @router.get('/path')
  { regex: /@\w+\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g, framework: 'fastapi', method: '', pathGroup: 2, handlerGroup: 0 },
  // Django urlpatterns
  { regex: /\bpath\s*\(\s*['"]([^'"]+)['"]/g, framework: 'django', method: 'ANY', pathGroup: 1, handlerGroup: 0 },
  // Laravel Route::
  { regex: /\bRoute::(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g, framework: 'laravel', method: '', pathGroup: 2, handlerGroup: 0 },
  // Next.js route.ts: export async function GET/POST/PUT/DELETE
  { regex: /export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH)\b/g, framework: 'nextjs', method: '', pathGroup: 1, handlerGroup: 1 },
];

export const routesPhase: PhaseDefinition<RoutesOutput> = {
  name: 'routes',
  dependencies: ['parse-emit'],

  execute(context: PhaseContext): RoutesOutput {
    const { graph } = context;
    let routeCount = 0;
    const frameworks = new Set<string>();

    // Collect files that look like route files
    const routeFileNodes: Array<{ id: string; filePath: string; content: string }> = [];
    for (const node of graph.iterNodes()) {
      if (node.label !== 'File') continue;
      const fp = node.properties.filePath as string | undefined;
      if (!fp) continue;
      const name = fp.split('/').pop() ?? '';
      // Heuristic: files in routes/api/controllers/handlers dirs or named route*
      if (/routes?[\/\\]/.test(fp) || /api[\/\\]/.test(fp) || /controller/i.test(fp) || /handler/i.test(fp) || /route/i.test(name)) {
        routeFileNodes.push({ id: node.id, filePath: fp, content: (node.properties.name ?? '') });
      }
    }

    // Apply patterns
    for (const file of routeFileNodes) {
      for (const pattern of routePatterns) {
        const text = file.content;
        let match;
        while ((match = pattern.regex.exec(text)) !== null) {
          const method = pattern.method || match[pattern.pathGroup - 1] || match[1];
          const path = match[pattern.pathGroup];
          if (!path) continue;

          const routeId = `route:${file.filePath}:${method}:${path}`;
          if (graph.getNode(routeId)) continue;

          graph.addNode({
            id: routeId,
            label: 'Route',
            properties: {
              name: `${method} ${path}`,
              filePath: file.filePath,
              method,
              path,
              framework: pattern.framework,
            },
          });

          graph.addRelationship({
            id: `route:${routeId}:file:${file.id}`,
            sourceId: file.id,
            targetId: routeId,
            type: 'HANDLES_ROUTE',
            confidence: 0.7,
            reason: `Route detected by ${pattern.framework} pattern in ${file.filePath}`,
          });

          routeCount++;
          frameworks.add(pattern.framework);
        }
      }
    }

    return { routeCount, frameworks: Array.from(frameworks) };
  },
};
