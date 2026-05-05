/**
 * Integration tests for the HTTP REST API server (#534).
 * Tests all 13 endpoints + middleware (auth, rate limiting, request tracing, CORS).
 *
 * Follows the same pattern as eval-server.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server, IncomingMessage } from 'node:http';
import { startHttpServer, shutdownHttpServer } from '../../src/server/http-server.js';
import { createSqliteStore } from '../../src/persist/sqlite.js';
import { createFtsSearch } from '../../src/search/fts.js';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import { loadRegistry, saveRegistry, type RegistryEntry } from '../../src/mcp/registry.js';

// ── Helpers ──────────────────────────────────────────────────────────────

let testDir: string;
let dbPath: string;
let server: Server;
let baseUrl: string;
let originalRegistry: RegistryEntry[];

function fetchJson(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; data: unknown; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    import('node:http').then((http) => {
      const req = http.request(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
      }, (res: IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(data), headers: res.headers as any });
          } catch {
            resolve({ status: res.statusCode ?? 0, data, headers: res.headers as any });
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
  originalRegistry = loadRegistry();

  testDir = mkdtempSync(join(tmpdir(), 'astrolabe-http-'));
  dbPath = join(testDir, 'http-test.db');

  // Create a small test graph
  const store = createSqliteStore(dbPath);
  const graph = createKnowledgeGraph();
  graph.addNode({ id: 'fn:test:authenticate', label: 'Function', properties: { name: 'authenticate', filePath: 'src/auth.ts' } });
  graph.addNode({ id: 'fn:test:login', label: 'Function', properties: { name: 'login', filePath: 'src/login.ts' } });
  graph.addNode({ id: 'fn:test:hashPassword', label: 'Function', properties: { name: 'hashPassword', filePath: 'src/auth.ts' } });
  graph.addRelationship({
    id: 'rel:call1', sourceId: 'fn:test:login', targetId: 'fn:test:authenticate',
    type: 'CALLS', confidence: 0.95, reason: 'test call',
  });
  graph.addRelationship({
    id: 'rel:call2', sourceId: 'fn:test:hashPassword', targetId: 'fn:test:authenticate',
    type: 'CALLS', confidence: 0.90, reason: 'test call',
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
    name: 'http-test-repo',
    path: testDir,
    dbPath,
    lastCommit: 'abc123',
    indexedAt: Date.now(),
  };
  saveRegistry([entry]);

  // Start server on port 0 (auto-assign)
  server = startHttpServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => {
    server.on('listening', resolve);
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 4747;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  shutdownHttpServer();
  server.close();
  saveRegistry(originalRegistry);
  rmSync(testDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('HTTP Server (#534)', () => {
  // ── Health & Discovery ──────────────────────────────────────────────
  describe('health & discovery', () => {
    it('GET /api/health returns 200 with status ok', async () => {
      const { status, data } = await fetchJson('GET', '/api/health');
      expect(status).toBe(200);
      const d = data as { status: string; uptime: number; repos: unknown[] };
      expect(d.status).toBe('ok');
      expect(typeof d.uptime).toBe('number');
      expect(Array.isArray(d.repos)).toBe(true);
    });

    it('GET /api/repos returns registered repos', async () => {
      const { status, data } = await fetchJson('GET', '/api/repos');
      expect(status).toBe(200);
      const d = data as { repos: Array<{ name: string }> };
      expect(d.repos.length).toBeGreaterThanOrEqual(1);
      expect(d.repos.some((r) => r.name === 'http-test-repo')).toBe(true);
    });
  });

  // ── Data Endpoints ──────────────────────────────────────────────────
  describe('data endpoints', () => {
    it('GET /api/repo/:name/context returns node and edge counts', async () => {
      const { status, data } = await fetchJson('GET', '/api/repo/http-test-repo/context');
      expect(status).toBe(200);
      const d = data as { name: string; nodes: number; relationships: number };
      expect(d.name).toBe('http-test-repo');
      expect(d.nodes).toBeGreaterThanOrEqual(3);
      expect(d.relationships).toBeGreaterThanOrEqual(2);
    });

    it('GET /api/repo/:name/clusters returns clusters array', async () => {
      const { status, data } = await fetchJson('GET', '/api/repo/http-test-repo/clusters');
      expect(status).toBe(200);
      const d = data as { clusters: unknown[] };
      expect(Array.isArray(d.clusters)).toBe(true);
    });

    it('GET /api/repo/:name/graph returns nodes and edges', async () => {
      const { status, data } = await fetchJson('GET', '/api/repo/http-test-repo/graph');
      expect(status).toBe(200);
      const d = data as { nodes: unknown[]; edges: unknown[]; nodeCount: number; edgeCount: number };
      expect(d.nodeCount).toBeGreaterThanOrEqual(3);
      expect(d.edgeCount).toBeGreaterThanOrEqual(2);
      expect(d.nodes.length).toBe(d.nodeCount);
      expect(d.edges.length).toBe(d.edgeCount);
    });

    it('POST /api/repo/:name/query returns FTS search results', async () => {
      const { status, data } = await fetchJson('POST', '/api/repo/http-test-repo/query', {
        query: 'authenticate',
        limit: 5,
      });
      expect(status).toBe(200);
      const d = data as { results: Array<{ name: string }> };
      expect(d.results.length).toBeGreaterThanOrEqual(1);
      expect(d.results[0].name).toBe('authenticate');
    });

    it('POST /api/repo/:name/query with missing query returns error', async () => {
      const { status, data } = await fetchJson('POST', '/api/repo/http-test-repo/query', {});
      expect(status).toBe(400);
      const d = data as { error: string };
      expect(d.error).toContain('query');
    });

    it('POST /api/repo/:name/impact returns impact results', async () => {
      const { status, data } = await fetchJson('POST', '/api/repo/http-test-repo/impact', {
        name: 'login',
      });
      expect(status).toBe(200);
      const d = data as { results: Array<{ name: string }> };
      expect(d.results.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/repo/:name/grep returns grep results', async () => {
      const { status, data } = await fetchJson('GET', '/api/repo/http-test-repo/grep?pattern=authenticate&limit=10');
      expect(status).toBe(200);
      const d = data as { matches: number; results: unknown[] };
      expect(typeof d.matches).toBe('number');
      expect(Array.isArray(d.results)).toBe(true);
    });

    it('GET /api/repo/:name/grep without pattern returns error', async () => {
      const { status, data } = await fetchJson('GET', '/api/repo/http-test-repo/grep');
      expect(status).toBe(400);
      const d = data as { error: string };
      expect(d.error).toContain('pattern');
    });

    it('GET /api/repo/nonexistent returns 404', async () => {
      const { status } = await fetchJson('GET', '/api/repo/nonexistent/context');
      expect(status).toBe(404);
    });
  });

  // ── Middleware ───────────────────────────────────────────────────────
  describe('middleware', () => {
    it('sets X-Request-Id header on responses', async () => {
      const { headers } = await fetchJson('GET', '/api/health');
      const requestId = headers['x-request-id'];
      expect(requestId).toBeDefined();
      expect(typeof requestId).toBe('string');
      expect(requestId!.length).toBeGreaterThan(0);
    });

    it('preserves client-provided X-Request-Id', async () => {
      const { headers } = await fetchJson('GET', '/api/health', undefined, {
        'X-Request-Id': 'my-custom-id-123',
      });
      expect(headers['x-request-id']).toBe('my-custom-id-123');
    });

    it('sets rate limit headers on responses', async () => {
      const { headers } = await fetchJson('GET', '/api/repos');
      expect(headers['x-ratelimit-limit']).toBeDefined();
      expect(headers['x-ratelimit-remaining']).toBeDefined();
      expect(headers['x-ratelimit-reset']).toBeDefined();
    });

    it('CORS preflight returns 204', async () => {
      const result = await new Promise<{ status: number }>((resolve, reject) => {
        import('node:http').then((http) => {
          const url = new URL('/api/health', baseUrl);
          const req = http.request(url, { method: 'OPTIONS' }, (res) => {
            resolve({ status: res.statusCode ?? 0 });
          });
          req.on('error', reject);
          req.end();
        });
      });
      expect(result.status).toBe(204);
    });

    it('returns 404 for unknown paths', async () => {
      const { status, data } = await fetchJson('GET', '/api/nonexistent');
      expect(status).toBe(404);
      const d = data as { error: string };
      expect(d.error).toContain('Not found');
    });
  });

  // ── Auth ─────────────────────────────────────────────────────────────
  describe('auth', () => {
    let authServer: Server;
    let authBaseUrl: string;
    let authOrigRegistry: RegistryEntry[];

    beforeAll(async () => {
      authOrigRegistry = loadRegistry();
      saveRegistry([]);
      authServer = startHttpServer({ port: 0, host: '127.0.0.1', apiKey: 'test-secret-key' });
      await new Promise<void>((resolve) => { authServer.on('listening', resolve); });
      const addr = authServer.address();
      const port = addr && typeof addr === 'object' ? addr.port : 4747;
      authBaseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(() => {
      shutdownHttpServer();
      authServer.close();
      saveRegistry(authOrigRegistry);
    });

    function fetchAuthJson(method: string, path: string, headers?: Record<string, string>): Promise<{ status: number }> {
      return new Promise((resolve, reject) => {
        import('node:http').then((http) => {
          const url = new URL(path, authBaseUrl);
          const req = http.request(url, { method, headers: headers ?? {} }, (res) => {
            res.resume(); // drain body
            resolve({ status: res.statusCode ?? 0 });
          });
          req.on('error', reject);
          req.end();
        });
      });
    }

    it('health endpoint skips auth', async () => {
      const { status } = await fetchAuthJson('GET', '/api/health');
      expect(status).toBe(200);
    });

    it('request without API key returns 401', async () => {
      const { status } = await fetchAuthJson('GET', '/api/repos');
      expect(status).toBe(401);
    });

    it('request with wrong API key returns 401', async () => {
      const { status } = await fetchAuthJson('GET', '/api/repos', {
        Authorization: 'Bearer wrong-key',
      });
      expect(status).toBe(401);
    });

    it('request with correct API key returns 200', async () => {
      const { status } = await fetchAuthJson('GET', '/api/repos', {
        Authorization: 'Bearer test-secret-key',
      });
      expect(status).toBe(200);
    });
  });
});
