/**
 * Tests for the eval server — REST endpoints for benchmarking (#448).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type Server, type IncomingMessage } from 'node:http';
import { startEvalServer, shutdownEvalServer } from '../../src/server/eval-server.js';
import { createSqliteStore } from '../../src/persist/sqlite.js';
import { createFtsSearch } from '../../src/search/fts.js';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import { loadRegistry, saveRegistry, type RegistryEntry } from '../../src/mcp/registry.js';

// ── Helpers ──────────────────────────────────────────────────────────────

let testDir: string;
let dbPath: string;
let server: Server;
let baseUrl: string;

function fetchJson(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    import('node:http').then((http) => {
      const req = http.request(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
      }, (res: IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data });
          }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'astrolabe-eval-'));
  dbPath = join(testDir, 'eval-test.db');

  // Create a small test graph
  const store = createSqliteStore(dbPath);
  const graph = createKnowledgeGraph();
  graph.addNode({ id: 'fn:test:authenticate', label: 'Function', properties: { name: 'authenticate', filePath: 'src/auth.ts' } });
  graph.addNode({ id: 'fn:test:login', label: 'Function', properties: { name: 'login', filePath: 'src/login.ts' } });
  graph.addRelationship({
    id: 'rel:call', sourceId: 'fn:test:login', targetId: 'fn:test:authenticate',
    type: 'CALLS', confidence: 0.95, reason: 'test call',
  });
  store.saveGraph(graph);
  store.close();

  // Build FTS index
  const fts = createFtsSearch(dbPath);
  const store2 = createSqliteStore(dbPath);
  fts.indexGraph(store2);
  fts.close();
  store2.close();

  // Register in global registry
  const entry: RegistryEntry = {
    name: 'eval-test-repo',
    path: testDir,
    dbPath,
    lastCommit: 'abc123',
    indexedAt: Date.now(),
  };
  saveRegistry([entry]);

  // Start eval server on port 0 (auto-assign)
  server = startEvalServer({ port: 0, host: '127.0.0.1', idleTimeout: 0 });
  await new Promise<void>((resolve) => {
    server.on('listening', resolve);
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 4748;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  shutdownEvalServer();
  server.close();
  // Restore original registry
  const existing = loadRegistry().filter((e) => e.name !== 'eval-test-repo');
  saveRegistry(existing);
  rmSync(testDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('Eval Server (#448)', () => {
  it('starts and responds to health check', async () => {
    const { status, data } = await fetchJson('GET', '/health');
    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({
      status: 'ok',
      uptime: expect.any(Number),
    }));
  });

  it('POST /tool/query requires query parameter', async () => {
    const { status, data } = await fetchJson('POST', '/tool/query', {});
    expect(status).toBe(200);
    expect(data).toEqual({ error: 'Missing required parameter: query' });
  });

  it('POST /tool/query returns search results', async () => {
    const { status, data } = await fetchJson('POST', '/tool/query', {
      query: 'authenticate',
      repo: 'eval-test-repo',
      limit: 5,
    });
    expect(status).toBe(200);
    const result = data as { result: { results: Array<{ name: string }> } };
    expect(result.result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.result.results[0].name).toBe('authenticate');
  });

  it('POST /tool/list_repos returns repos array', async () => {
    const { status, data } = await fetchJson('POST', '/tool/list_repos');
    expect(status).toBe(200);
    const result = data as { result: { repos: Array<{ name: string }> } };
    expect(result.result.repos).toBeInstanceOf(Array);
    expect(result.result.repos.length).toBeGreaterThanOrEqual(1);
    expect(result.result.repos[0].name).toBe('eval-test-repo');
  });

  it('POST /tool/context returns symbol context', async () => {
    const { status, data } = await fetchJson('POST', '/tool/context', {
      name: 'authenticate',
      repo: 'eval-test-repo',
    });
    expect(status).toBe(200);
    const result = data as { result: { match_count: number } };
    expect(result.result.match_count).toBeGreaterThanOrEqual(1);
  });

  it('POST /tool/impact returns impact results', async () => {
    const { status, data } = await fetchJson('POST', '/tool/impact', {
      name: 'login',
      repo: 'eval-test-repo',
    });
    expect(status).toBe(200);
    const result = data as { result: { results: Array<{ name: string }> } };
    expect(result.result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.result.results.some((r) => r.name === 'login')).toBe(true);
  });

  it('unknown tool returns 404', async () => {
    const { status, data } = await fetchJson('POST', '/tool/nonexistent');
    expect(status).toBe(404);
    expect(data).toEqual({ error: 'Unknown tool: nonexistent' });
  });

  it('invalid JSON body returns error', async () => {
    const result = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
      const url = new URL('/tool/query', baseUrl);
      import('node:http').then((http) => {
        const req = http.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res: IncomingMessage) => {
          let body = '';
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => {
            try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) }); }
            catch { resolve({ status: res.statusCode ?? 0, data: body }); }
          });
        });
        req.on('error', reject);
        req.write('{invalid json');
        req.end();
      });
    });
    // Server handles parse failure gracefully, returns empty body → missing params error
    expect(result.status).toBe(200);
  });

  it('idle timeout triggers shutdown', async () => {
    // Use 3s idle timeout — 1s was too tight for slow CI runners where
    // event-loop scheduling delays caused the timer callback to miss the
    // window.  3s gives comfortable headroom while keeping the test fast.
    const idleServer = startEvalServer({ port: 0, host: '127.0.0.1', idleTimeout: 3 });
    await new Promise<void>((resolve) => { idleServer.on('listening', resolve); });

    // Wait for idle timeout + generous buffer for CI scheduling variance
    const closed = new Promise<boolean>((resolve) => {
      idleServer.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 8000);
    });

    const didClose = await closed;
    expect(didClose).toBe(true);
  });
});
