/**
 * Tests for response shape extraction from route handler code (#426).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { routesPhase, extractResponseKeys } from '../../../src/analysis/phases/routes.js';
import type { RoutesOutput } from '../../../src/analysis/phases/routes.js';
import { createPhaseContext, runPipeline } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';

function makeRepo(fixtures: Record<string, string>): string {
  const tmp = mkdtempSync(join(tmpdir(), 'astrolabe-resp-'));
  for (const [path, content] of Object.entries(fixtures)) {
    const fullPath = join(tmp, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return tmp;
}

// ── Unit tests for extractResponseKeys ──────────────────────────────────────

describe('extractResponseKeys', () => {
  it('extracts top-level keys from res.json({...})', () => {
    const code = `app.get('/api/users', (req, res) => res.json({ users: [], count: 0 }));`;
    const { responseKeys } = extractResponseKeys(code);
    expect(responseKeys).toContain('users');
    expect(responseKeys).toContain('count');
  });

  it('extracts keys from res.send({...})', () => {
    const code = `app.get('/api/status', (req, res) => res.send({ ok: true, uptime: 99 }));`;
    const { responseKeys } = extractResponseKeys(code);
    expect(responseKeys).toContain('ok');
    expect(responseKeys).toContain('uptime');
  });

  it('extracts keys from NextResponse.json({...})', () => {
    const code = `return NextResponse.json({ items: [], total: 0 });`;
    const { responseKeys } = extractResponseKeys(code);
    expect(responseKeys).toContain('items');
    expect(responseKeys).toContain('total');
  });

  it('extracts keys from Response.json({...})', () => {
    const code = `return Response.json({ data: null, success: true });`;
    const { responseKeys } = extractResponseKeys(code);
    expect(responseKeys).toContain('data');
    expect(responseKeys).toContain('success');
  });

  it('extracts keys from Python jsonify({...})', () => {
    const code = `return jsonify({ name: "test", value: 42 })`;
    const { responseKeys } = extractResponseKeys(code);
    expect(responseKeys).toContain('name');
    expect(responseKeys).toContain('value');
  });

  it('extracts keys from return {...} statements', () => {
    const code = `return { message: "hello", status: "ok" }`;
    const { responseKeys } = extractResponseKeys(code);
    expect(responseKeys).toContain('message');
    expect(responseKeys).toContain('status');
  });

  it('detects error response keys from res.status(4xx).json({...})', () => {
    const code = `res.status(404).json({ error: "Not found", code: 404 })`;
    const { errorKeys } = extractResponseKeys(code);
    expect(errorKeys).toContain('error');
    expect(errorKeys).toContain('code');
  });

  it('detects error response keys from res.status(5xx).json({...})', () => {
    const code = `res.status(500).json({ error: "Internal server error" })`;
    const { errorKeys } = extractResponseKeys(code);
    expect(errorKeys).toContain('error');
  });

  it('returns empty arrays when no response patterns found', () => {
    const code = `const x = 42; console.log(x);`;
    const { responseKeys, errorKeys } = extractResponseKeys(code);
    expect(responseKeys).toEqual([]);
    expect(errorKeys).toEqual([]);
  });

  it('ignores keys from deeply nested objects (only top-level)', () => {
    const code = `res.json({ users: [{ name: "a", profile: { age: 20 } }], count: 1 })`;
    const { responseKeys } = extractResponseKeys(code);
    expect(responseKeys).toContain('users');
    expect(responseKeys).toContain('count');
    expect(responseKeys).not.toContain('name');
    expect(responseKeys).not.toContain('profile');
    expect(responseKeys).not.toContain('age');
  });

  it('handles multiple response patterns in the same code', () => {
    const code = `
      res.json({ users: [] });
      res.json({ items: [], total: 0 });
    `;
    const { responseKeys } = extractResponseKeys(code);
    expect(responseKeys).toContain('users');
    expect(responseKeys).toContain('items');
    expect(responseKeys).toContain('total');
  });

  it('deduplicates response keys', () => {
    const code = `
      res.json({ data: null });
      res.send({ data: [], ok: true });
    `;
    const { responseKeys } = extractResponseKeys(code);
    const dataCount = responseKeys.filter(k => k === 'data').length;
    expect(dataCount).toBe(1);
    expect(responseKeys).toContain('ok');
  });
});

// ── Integration tests (full pipeline) ───────────────────────────────────────

describe('Response Shape Integration', () => {
  it('stores responseKeys on Route nodes', async () => {
    const repo = makeRepo({
      'routes/users.ts': `
        const app = require('express')();
        app.get('/api/users', (req, res) => res.json({ users: [], count: 0 }));
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

    expect(output.responseShapeCount).toBeGreaterThanOrEqual(1);

    const routeNodes = graph.findNodesByLabel('Route');
    const usersRoute = routeNodes.find(n => n.properties.path === '/api/users');
    expect(usersRoute).toBeDefined();
    expect(usersRoute!.properties.responseKeys).toContain('users');
    expect(usersRoute!.properties.responseKeys).toContain('count');

    rmSync(repo, { recursive: true, force: true });
  });

  it('stores errorKeys on Route nodes for error responses', async () => {
    const repo = makeRepo({
      'api/errors.ts': `
        const app = require('express')();
        app.get('/api/data', (req, res) => {
          res.status(404).json({ error: "Not found", code: 404 });
        });
      `,
    });

    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'file:api/errors.ts',
      label: 'File',
      properties: { name: 'errors.ts', filePath: 'api/errors.ts' },
    });
    const context = createPhaseContext(repo, graph, () => {});
    const output = (await runPipeline([routesPhase], context))[0] as RoutesOutput;

    expect(output.responseShapeCount).toBeGreaterThanOrEqual(1);

    const routeNodes = graph.findNodesByLabel('Route');
    const route = routeNodes.find(n => n.properties.path === '/api/data');
    expect(route).toBeDefined();
    expect(route!.properties.errorKeys).toContain('error');
    expect(route!.properties.errorKeys).toContain('code');

    rmSync(repo, { recursive: true, force: true });
  });
});
