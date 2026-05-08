/**
 * Tests for middleware chain extraction from route definitions (#427).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { routesPhase, extractMiddlewareNames } from '../../../src/analysis/phases/routes.js';
import type { RoutesOutput } from '../../../src/analysis/phases/routes.js';
import { createPhaseContext, runPipeline } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';

function makeRepo(fixtures: Record<string, string>): string {
  const tmp = mkdtempSync(join(tmpdir(), 'astrolabe-mw-'));
  for (const [path, content] of Object.entries(fixtures)) {
    const fullPath = join(tmp, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return tmp;
}

// ── Unit tests for extractMiddlewareNames ────────────────────────────────────

describe('extractMiddlewareNames', () => {
  it('extracts middleware from Express app.get(path, mw, handler)', () => {
    const code = `app.get('/api/users', authenticate, (req, res) => res.json([]));`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('authenticate');
  });

  it('extracts multiple middleware from Express route', () => {
    const code = `app.post('/api/orders', validateBody, authenticate, rateLimit, (req, res) => {});`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('validateBody');
    expect(middleware).toContain('authenticate');
    expect(middleware).toContain('rateLimit');
  });

  it('extracts middleware from router.get(path, mw, handler)', () => {
    const code = `router.get('/api/data', auth, (req, res) => res.json({}));`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('auth');
  });

  it('detects higher-order function wrapper withAuth(handler)', () => {
    const code = `module.exports = withAuth(async function handler(req, res) { res.json({}) });`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('withAuth');
  });

  it('detects higher-order wrapper with arrow function', () => {
    const code = `export default withRateLimit((req) => Response.json({}));`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('withRateLimit');
  });

  it('detects wrapper with variable handler', () => {
    const code = `const handler = withAuth(myHandler);`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('withAuth');
  });

  it('returns empty array when no middleware present', () => {
    const code = `const x = 42;`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toEqual([]);
  });

  it('does not extract req/res/next as middleware', () => {
    const code = `app.get('/api/test', (req, res, next) => res.json({}));`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).not.toContain('req');
    expect(middleware).not.toContain('res');
    expect(middleware).not.toContain('next');
  });

  it('deduplicates middleware names', () => {
    const code = `
      app.get('/a', auth, (req, res) => {});
      app.post('/b', auth, (req, res) => {});
    `;
    const middleware = extractMiddlewareNames(code);
    const authCount = middleware.filter(m => m === 'auth').length;
    expect(authCount).toBe(1);
  });

  it('extracts middleware from Express put/delete/patch routes', () => {
    const code = `app.put('/api/items/:id', validate, authorize, (req, res) => res.json({}));`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('validate');
    expect(middleware).toContain('authorize');
  });

  it('detects wrapper pattern with *Handler suffix', () => {
    const code = `export default withLogging(userHandler);`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('withLogging');
  });

  it('detects wrapper pattern with *Controller suffix', () => {
    const code = `app.get('/api/test', withValidation(itemController));`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('withValidation');
  });
});

// ── Integration tests (full pipeline) ───────────────────────────────────────

describe('Middleware Integration', () => {
  it('stores middleware names on Route nodes', async () => {
    const repo = makeRepo({
      'routes/users.ts': `
        const app = require('express')();
        app.get('/api/users', authenticate, authorize, (req, res) => res.json([]));
      `,
    });

    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'file:routes/users.ts',
      label: 'File',
      properties: { name: 'users.ts', filePath: 'routes/users.ts' },
    });
    const context = createPhaseContext(repo, graph, () => {});
    const output = (await runPipeline([routesPhase], context))[0] as RoutesOutput;

    expect(output.middlewareCount).toBeGreaterThanOrEqual(1);

    const routeNodes = graph.findNodesByLabel('Route');
    const usersRoute = routeNodes.find(n => n.properties.path === '/api/users');
    expect(usersRoute).toBeDefined();
    expect(usersRoute!.properties.middleware).toContain('authenticate');
    expect(usersRoute!.properties.middleware).toContain('authorize');

    rmSync(repo, { recursive: true, force: true });
  });

  it('reports zero middlewareCount when no middleware present', async () => {
      const repo = makeRepo({
        'routes/simple.ts': `
          const app = require('express')();
          app.get('/api/health', (req, res) => res.json({ ok: true }));
        `,
      });

      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'file:routes/simple.ts',
        label: 'File',
        properties: { name: 'simple.ts', filePath: 'routes/simple.ts' },
      });
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([routesPhase], context))[0] as RoutesOutput;

      expect(output.middlewareCount).toBe(0);

      rmSync(repo, { recursive: true, force: true });
    });

  // ── #637: WRAPS edge creation ────────────────────────────────────────────

  it('creates WRAPS edges from Function nodes to Route nodes for middleware (#637)', async () => {
    const repo = makeRepo({
      'routes/users.ts': `
        const app = require('express')();
        app.get('/api/users', authenticate, authorize, (req, res) => res.json([]));
      `,
    });

    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'file:routes/users.ts',
      label: 'File',
      properties: { name: 'users.ts', filePath: 'routes/users.ts' },
    });
    // Add Function nodes for the middleware so WRAPS edges target them
    graph.addNode({
      id: 'Function:routes/users.ts:authenticate',
      label: 'Function',
      properties: { name: 'authenticate', filePath: 'routes/users.ts', startLine: 3, endLine: 10 },
    });
    graph.addNode({
      id: 'Function:routes/users.ts:authorize',
      label: 'Function',
      properties: { name: 'authorize', filePath: 'routes/users.ts', startLine: 12, endLine: 20 },
    });
    const context = createPhaseContext(repo, graph, () => {});
    const output = (await runPipeline([routesPhase], context))[0] as RoutesOutput;

    expect(output.wrapsCount).toBeGreaterThanOrEqual(2);

    const wrapsRels = Array.from(graph.iterRelationshipsByType('WRAPS'));
    expect(wrapsRels.length).toBeGreaterThanOrEqual(2);
    // WRAPS edges: middleware function → Route node
    for (const rel of wrapsRels) {
      expect(rel.type).toBe('WRAPS');
      const sourceNode = graph.getNode(rel.sourceId);
      expect(sourceNode?.label === 'Function' || sourceNode?.label === 'CodeElement').toBe(true);
      const targetNode = graph.getNode(rel.targetId);
      expect(targetNode?.label).toBe('Route');
    }

    rmSync(repo, { recursive: true, force: true });
  });

  it('creates synthetic CodeElement nodes for middleware with no matching Function (#637)', async () => {
    const repo = makeRepo({
      'routes/api.ts': `
        const app = require('express')();
        app.get('/api/data', rateLimit, (req, res) => res.json({}));
      `,
    });

    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'file:routes/api.ts',
      label: 'File',
      properties: { name: 'api.ts', filePath: 'routes/api.ts' },
    });
    // No Function node for rateLimit — should create synthetic CodeElement
    const context = createPhaseContext(repo, graph, () => {});
    const output = (await runPipeline([routesPhase], context))[0] as RoutesOutput;

    expect(output.wrapsCount).toBeGreaterThanOrEqual(1);

    const mwNodes = graph.findNodesByLabel('CodeElement').filter(n => n.properties.kind === 'middleware');
    expect(mwNodes.length).toBeGreaterThanOrEqual(1);
    expect(mwNodes.some(n => n.properties.name === 'rateLimit')).toBe(true);

    rmSync(repo, { recursive: true, force: true });
  });

  // ── #637: New middleware pattern detection ────────────────────────────────

  it('extracts FastAPI Depends() middleware (#637)', () => {
    const code = `@router.get('/items')\ndef read_items(db: Session = Depends(get_db), user: User = Depends(get_current_user)): ...`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('get_db');
    expect(middleware).toContain('get_current_user');
  });

  it('extracts Django decorators (#637)', () => {
    const code = `@login_required\n@permission_required('polls.vote')\ndef vote(request): ...`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('login_required');
    expect(middleware).toContain('permission_required');
  });

  it('extracts Django @csrf_exempt decorator (#637)', () => {
    const code = `@csrf_exempt\ndef api_endpoint(request): ...`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('csrf_exempt');
  });

  it('extracts Laravel middleware() chains (#637)', () => {
    const code = `Route::get('/profile', 'ProfileController@show')->middleware('auth');`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('auth');
  });

  it('extracts Laravel middleware with colon-separated params (#637)', () => {
    const code = `Route::get('/api/data', 'DataController@index')->middleware('throttle:60,1');`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('throttle');
  });

  it('extracts Express app.use() middleware (#637)', () => {
    const code = `app.use(corsHandler);\napp.use(authMiddleware);`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('corsHandler');
    expect(middleware).toContain('authMiddleware');
  });

  it('extracts Koa app.use() middleware (#637)', () => {
    const code = `koa.use(logger);`;
    const middleware = extractMiddlewareNames(code);
    expect(middleware).toContain('logger');
  });
});
