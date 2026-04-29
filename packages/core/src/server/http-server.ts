/**
 * HTTP Server — REST API for Astrolabe knowledge graph (#262).
 *
 * Starts a local HTTP server exposing graph data via REST endpoints.
 * Supports web UI connectivity, Docker deployment, and headless integration.
 *
 * Uses Node.js built-in http module — no external dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createSqliteStore } from '../persist/sqlite.js';
import { createFtsSearch } from '../search/fts.js';
import { loadRegistry } from '../mcp/registry.js';
import { loadMeta } from '../analysis/meta.js';
import { dirname } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ServeOptions {
  port?: number;
  host?: string;
  /** API key for bearer token auth (#329). Falls back to ASTROLABE_API_KEY env. */
  apiKey?: string;
  /** Allowed CORS origin (#328). Defaults to * on localhost, host:port otherwise. */
  allowOrigin?: string;
}

// ── Connection pool ────────────────────────────────────────────────────────

const MAX_CONNS = 5;

const repos = new Map<string, {
  store: ReturnType<typeof createSqliteStore>;
  fts: ReturnType<typeof createFtsSearch>;
  graph?: ReturnType<ReturnType<typeof createSqliteStore>['loadGraph']>; // #330: cache loaded graph
  lastAccess: number;
}>();

function getRepo(dbPath: string, name: string) {
  let ctx = repos.get(name);
  if (ctx) {
    ctx.lastAccess = Date.now();
    return ctx;
  }

  // Evict oldest if at capacity
  if (repos.size >= MAX_CONNS) {
    let oldest = '';
    let oldestTime = Infinity;
    for (const [n, c] of repos) {
      if (c.lastAccess < oldestTime) { oldest = n; oldestTime = c.lastAccess; }
    }
    if (oldest && repos.has(oldest)) {
      const old = repos.get(oldest)!;
      old.store.close();
      old.fts.close();
      repos.delete(oldest);
    }
  }

  const store = createSqliteStore(dbPath);
  const fts = createFtsSearch(dbPath);
  ctx = { store, fts, lastAccess: Date.now() };
  repos.set(name, ctx);
  return ctx;
}

// ── JSON helpers ──────────────────────────────────────────────────────────

let _corsOrigin = '*';
let _apiKey: string | undefined;

function authMiddleware(req: IncomingMessage, res: ServerResponse): boolean {
  if (!_apiKey) return true; // no auth configured
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${_apiKey}`) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': _corsOrigin,
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': _corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// ── Route handlers ────────────────────────────────────────────────────────

async function handleRepos(res: ServerResponse) {
  const entries = loadRegistry();
  const repos = entries.map((e) => ({
    name: e.name,
    path: e.path,
    lastCommit: e.lastCommit,
    indexedAt: new Date(e.indexedAt).toISOString(),
  }));
  json(res, { repos });
}

async function handleContext(res: ServerResponse, repoName: string) {
  const entries = loadRegistry();
  const entry = entries.find((e) => e.name === repoName);
  if (!entry) return error(res, `Repo "${repoName}" not found`, 404);

  try {
    const ctx = getRepo(entry.dbPath, repoName);
    // #330: Cache loaded graph in connection pool
    if (!ctx.graph) ctx.graph = ctx.store.loadGraph();
    const graph = ctx.graph;

    let meta = null;
    try { meta = loadMeta(dirname(entry.dbPath)); } catch { /* no meta */ }

    json(res, {
      name: entry.name,
      path: entry.path,
      nodes: graph.nodeCount,
      relationships: graph.relationshipCount,
      lastCommit: entry.lastCommit,
      indexedAt: new Date(entry.indexedAt).toISOString(),
      metaStale: meta ? meta.lastCommit !== entry.lastCommit : null,
    });
  } catch (err) {
    error(res, `Failed to read repo: ${(err as Error).message}`, 500);
  }
}

async function handleClusters(res: ServerResponse, repoName: string) {
  const entries = loadRegistry();
  const entry = entries.find((e) => e.name === repoName);
  if (!entry) return error(res, `Repo "${repoName}" not found`, 404);

  try {
    const ctx = getRepo(entry.dbPath, repoName);
    // #330: Cache loaded graph in connection pool
    if (!ctx.graph) ctx.graph = ctx.store.loadGraph();
    const graph = ctx.graph;
    const clusters: unknown[] = [];
    for (const node of graph.iterNodes()) {
      if (node.label === 'Community') clusters.push({
        id: node.id,
        name: node.properties.name,
        symbolCount: node.properties.symbolCount ?? 0,
        cohesion: node.properties.cohesion ?? 0,
      });
    }
    json(res, { clusters });
  } catch (err) {
    error(res, String(err), 500);
  }
}

async function handleQuery(res: ServerResponse, repoName: string, params: Record<string, unknown>) {
  const entries = loadRegistry();
  const entry = entries.find((e) => e.name === repoName);
  if (!entry) return error(res, `Repo "${repoName}" not found`, 404);

  const query = (params.query as string) || '';
  const limit = (params.limit as number) || 20;
  if (!query) return error(res, 'Missing query parameter');

  try {
    const ctx = getRepo(entry.dbPath, repoName);
    const results = ctx.fts.search(query, limit);
    json(res, { results: results.map((r) => ({ label: r.label, name: r.name, filePath: r.filePath, rank: (r as any).rank })) });
  } catch (err) {
    error(res, String(err), 500);
  }
}

async function handleImpact(res: ServerResponse, repoName: string, params: Record<string, unknown>) {
  const entries = loadRegistry();
  const entry = entries.find((e) => e.name === repoName);
  if (!entry) return error(res, `Repo "${repoName}" not found`, 404);

  const symbolName = (params.name as string) || '';
  if (!symbolName) return error(res, 'Missing name parameter');

  try {
    const ctx = getRepo(entry.dbPath, repoName);
    // #330: Cache loaded graph in connection pool
    if (!ctx.graph) ctx.graph = ctx.store.loadGraph();
    const graph = ctx.graph;

    // Build adjacency index
    const adj = new Map<string, Array<{ neighborId: string; type: string; direction: string }>>();
    for (const rel of graph.iterRelationships()) {
      let b = adj.get(rel.sourceId);
      if (!b) { b = []; adj.set(rel.sourceId, b); }
      b.push({ neighborId: rel.targetId, type: rel.type, direction: 'outgoing' });
      b = adj.get(rel.targetId);
      if (!b) { b = []; adj.set(rel.targetId, b); }
      b.push({ neighborId: rel.sourceId, type: rel.type, direction: 'incoming' });
    }

    const results: unknown[] = [];
    for (const node of graph.iterNodes()) {
      if (node.properties.name === symbolName) {
        results.push({
          id: node.id,
          label: node.label,
          name: node.properties.name,
          filePath: node.properties.filePath,
          neighbors: (adj.get(node.id) ?? []).map((n) => ({
            direction: n.direction,
            type: n.type,
            targetName: graph.getNode(n.neighborId)?.properties.name ?? n.neighborId,
          })),
        });
      }
    }

    json(res, { results });
  } catch (err) {
    error(res, String(err), 500);
  }
}

// ── Server ────────────────────────────────────────────────────────────────

export function startHttpServer(opts: ServeOptions = {}): Server {
  const port = opts.port ?? 4747;
  const host = opts.host ?? 'localhost';

  // #328: Restrict CORS when bound to non-localhost
  _corsOrigin = opts.allowOrigin ?? (
    (host === 'localhost' || host === '127.0.0.1' || host === '::1') ? '*' : `http://${host}:${port}`
  );

  // #329: API key authentication
  _apiKey = opts.apiKey || process.env.ASTROLABE_API_KEY || undefined;
  if (_apiKey) {
    console.error('Astrolabe HTTP server: API key authentication enabled');
  }

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': _corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    // #329: Auth middleware
    if (!authMiddleware(req, res)) return;

    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const path = url.pathname;

    try {
      // GET /api/repos
      if (req.method === 'GET' && path === '/api/repos') {
        return await handleRepos(res);
      }

      // GET /api/repo/:name/context
      const ctxMatch = path.match(/^\/api\/repo\/([^/]+)\/context$/);
      if (req.method === 'GET' && ctxMatch) {
        return await handleContext(res, decodeURIComponent(ctxMatch[1]));
      }

      // GET /api/repo/:name/clusters
      const clMatch = path.match(/^\/api\/repo\/([^/]+)\/clusters$/);
      if (req.method === 'GET' && clMatch) {
        return await handleClusters(res, decodeURIComponent(clMatch[1]));
      }

      // POST /api/repo/:name/query
      const qMatch = path.match(/^\/api\/repo\/([^/]+)\/query$/);
      if (req.method === 'POST' && qMatch) {
        const body = await parseBody(req);
        return await handleQuery(res, decodeURIComponent(qMatch[1]), body);
      }

      // POST /api/repo/:name/impact
      const imMatch = path.match(/^\/api\/repo\/([^/]+)\/impact$/);
      if (req.method === 'POST' && imMatch) {
        const body = await parseBody(req);
        return await handleImpact(res, decodeURIComponent(imMatch[1]), body);
      }

      // Health check — also serves as bridge auto-detect endpoint (#377)
      if (req.method === 'GET' && path === '/api/health') {
        const registry = loadRegistry();
        return json(res, {
          status: 'ok',
          uptime: process.uptime(),
          repos: registry.map((r) => ({
            name: r.name,
            path: r.path,
            indexedAt: r.indexedAt,
            lastCommit: r.lastCommit,
          })),
        });
      }

      // 404
      error(res, `Not found: ${req.method} ${path}`, 404);
    } catch (err) {
      error(res, String(err), 500);
    }
  });

  server.listen(port, host, () => {
    console.error(`Astrolabe HTTP server listening on http://${host}:${port}`);
    console.error(`API docs: http://${host}:${port}/api/repos`);
  });

  // #332: Graceful shutdown — close all connections
  const cleanup = () => {
    shutdownHttpServer();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return server;
}

// ── Shutdown ────────────────────────────────────────────────────────────────

/**
 * Close all cached SQLite connections (#332).
 * Call this on server shutdown to prevent WAL file locks.
 */
export function shutdownHttpServer(): void {
  for (const [, ctx] of repos) {
    ctx.store.close();
    ctx.fts.close();
    ctx.graph = undefined;
  }
  repos.clear();
}
