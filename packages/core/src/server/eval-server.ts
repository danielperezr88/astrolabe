/**
 * Eval Server — REST API for benchmarking (#448).
 *
 * Maps MCP tools to REST POST endpoints for SWE-bench compatible
 * benchmarking. No MCP protocol, no auth — pure REST with JSON bodies.
 *
 * Uses Node.js built-in http module — no external dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createSqliteStore } from '../persist/sqlite.js';
import { createFtsSearch } from '../search/fts.js';
import { loadRegistry } from '../mcp/registry.js';
import { execFileSync } from 'node:child_process';
import { createLogger } from '../logging/logger.js';

const log = createLogger({ level: 'info' });

// ── Types ──────────────────────────────────────────────────────────────────

export interface EvalServerOptions {
  port?: number;       // default 4748
  host?: string;       // default 'localhost'
  idleTimeout?: number; // seconds, default 300 (5 min)
}

// ── Connection pool ────────────────────────────────────────────────────────

// Eval mode: keep connections warm, no LRU eviction
const repos = new Map<string, {
  store: ReturnType<typeof createSqliteStore>;
  fts: ReturnType<typeof createFtsSearch>;
  graph?: ReturnType<ReturnType<typeof createSqliteStore>['loadGraph']>;
  lastAccess: number;
}>();

function getRepo(dbPath: string, name: string) {
  let ctx = repos.get(name);
  if (ctx) {
    ctx.lastAccess = Date.now();
    return ctx;
  }

  const store = createSqliteStore(dbPath);
  const fts = createFtsSearch(dbPath);
  ctx = { store, fts, lastAccess: Date.now() };
  repos.set(name, ctx);
  return ctx;
}

// ── JSON helpers ──────────────────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  // Sanitize: early return on Error objects to prevent stack trace exposure
  if (data instanceof Error) {
    res.end(JSON.stringify({ error: data.message }));
    return;
  }
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

// #471: Body size limit to prevent DoS (10 MB, same as MCP transport)
const MAX_BODY_SIZE = 10 * 1024 * 1024;

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    let overflow = false;
    req.on('data', (chunk: string) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        overflow = true;
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (overflow) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// ── Tool implementations ──────────────────────────────────────────────────

function toolQuery(params: Record<string, unknown>): unknown {
  const query = params.query as string;
  if (!query || typeof query !== 'string' || query.length === 0) {
    throw new Error('Missing required parameter: query');
  }
  const repoName = params.repo as string | undefined;
  const limit = (typeof params.limit === 'number' ? params.limit : 20);

  const entries = loadRegistry();
  const name = repoName ?? entries[0]?.name;
  if (!name) throw new Error('No indexed repositories. Run `astrolabe analyze` first.');

  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`Repository "${name}" not found.`);

  const ctx = getRepo(entry.dbPath, name);
  const results = ctx.fts.search(query, limit);
  return { results: results.map((r) => ({
    label: r.label,
    name: r.name,
    filePath: r.filePath,
    rank: r.score,
  })) };
}

function toolContext(params: Record<string, unknown>): unknown {
  const name = params.name as string;
  if (!name || typeof name !== 'string' || name.length === 0) {
    throw new Error('Missing required parameter: name');
  }
  const repoName = params.repo as string | undefined;

  const entries = loadRegistry();
  const repo = repoName ?? entries[0]?.name;
  if (!repo) throw new Error('No indexed repositories. Run `astrolabe analyze` first.');

  const entry = entries.find((e) => e.name === repo);
  if (!entry) throw new Error(`Repository "${repo}" not found.`);

  const ctx = getRepo(entry.dbPath, repo);
  if (!ctx.graph) ctx.graph = ctx.store.loadGraph();
  const graph = ctx.graph;

  const symbols: Array<{ id: string; label: string; name: string; filePath: string; startLine: number }> = [];
  for (const node of graph.iterNodes()) {
    if (node.id === name || node.properties.name === name) {
      symbols.push({
        id: node.id,
        label: node.label,
        name: (node.properties.name as string) ?? '',
        filePath: (node.properties.filePath as string) ?? '',
        startLine: (node.properties.startLine as number) ?? 0,
      });
    }
  }
  if (symbols.length === 0) return { error: `Symbol "${name}" not found.` };

  // Build adjacency
  const incomingMap = new Map<string, Map<string, string[]>>();
  const outgoingMap = new Map<string, Map<string, string[]>>();

  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'STEP_IN_PROCESS') continue;
    let inc = incomingMap.get(rel.targetId);
    if (!inc) { inc = new Map(); incomingMap.set(rel.targetId, inc); }
    const incType = rel.type.toLowerCase();
    let incNames = inc.get(incType);
    if (!incNames) { incNames = []; inc.set(incType, incNames); }
    incNames.push(graph.getNode(rel.sourceId)?.properties.name as string ?? rel.sourceId);

    let out = outgoingMap.get(rel.sourceId);
    if (!out) { out = new Map(); outgoingMap.set(rel.sourceId, out); }
    const outType = rel.type.toLowerCase();
    let outNames = out.get(outType);
    if (!outNames) { outNames = []; out.set(outType, outNames); }
    outNames.push(graph.getNode(rel.targetId)?.properties.name as string ?? rel.targetId);
  }

  const matches = symbols.map((symbol) => {
    const inc = incomingMap.get(symbol.id);
    const incoming: Record<string, string[]> = {};
    if (inc) { for (const [t, names] of inc) incoming[t] = names; }

    const out = outgoingMap.get(symbol.id);
    const outgoing: Record<string, string[]> = {};
    if (out) { for (const [t, names] of out) outgoing[t] = names; }

    return { symbol, incoming, outgoing };
  });

  return { match_count: matches.length, matches };
}

function toolImpact(params: Record<string, unknown>): unknown {
  const targetName = params.name as string;
  if (!targetName || typeof targetName !== 'string' || targetName.length === 0) {
    throw new Error('Missing required parameter: name');
  }
  const repoName = params.repo as string | undefined;

  const entries = loadRegistry();
  const repo = repoName ?? entries[0]?.name;
  if (!repo) throw new Error('No indexed repositories. Run `astrolabe analyze` first.');

  const entry = entries.find((e) => e.name === repo);
  if (!entry) throw new Error(`Repository "${repo}" not found.`);

  const ctx = getRepo(entry.dbPath, repo);
  if (!ctx.graph) ctx.graph = ctx.store.loadGraph();
  const graph = ctx.graph;

  // Build adjacency
  const adj = new Map<string, Array<{ neighborId: string; type: string; direction: string }>>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'STEP_IN_PROCESS') continue;
    let b = adj.get(rel.sourceId);
    if (!b) { b = []; adj.set(rel.sourceId, b); }
    b.push({ neighborId: rel.targetId, type: rel.type, direction: 'outgoing' });
    b = adj.get(rel.targetId);
    if (!b) { b = []; adj.set(rel.targetId, b); }
    b.push({ neighborId: rel.sourceId, type: rel.type, direction: 'incoming' });
  }

  const results: Array<{ id: string; label: string; name: string; filePath: string; neighbors: unknown[] }> = [];
  for (const node of graph.iterNodes()) {
    if (node.properties.name === targetName) {
      results.push({
        id: node.id,
        label: node.label,
        name: (node.properties.name as string) ?? '',
        filePath: (node.properties.filePath as string) ?? '',
        neighbors: (adj.get(node.id) ?? []).map((n) => ({
          direction: n.direction,
          type: n.type,
          targetName: graph.getNode(n.neighborId)?.properties.name ?? n.neighborId,
        })),
      });
    }
  }
  return { results };
}

function toolListRepos(): unknown {
  const entries = loadRegistry();
  return {
    repos: entries.map((e) => ({
      name: e.name,
      path: e.path,
      lastCommit: e.lastCommit,
      indexedAt: new Date(e.indexedAt).toISOString(),
    })),
  };
}

function toolDetectChanges(params: Record<string, unknown>): unknown {
  const repoName = params.repo as string | undefined;
  const scope = (params.scope as string) ?? 'unstaged';

  const entries = loadRegistry();
  const name = repoName ?? entries[0]?.name;
  if (!name) throw new Error('No indexed repositories. Run `astrolabe analyze` first.');

  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`Repository "${name}" not found.`);

  const validScopes = ['unstaged', 'staged', 'all'];
  if (!validScopes.includes(scope)) {
    return { error: `Invalid scope "${scope}". Use: ${validScopes.join(', ')}` };
  }

  let diffFiles: string[] = [];
  try {
    const diffFlag = scope === 'staged' ? '--cached' : scope === 'all' ? 'HEAD' : '';
    const args = ['diff', '--name-only'];
    if (diffFlag) args.push(diffFlag);
    const output = execFileSync('git', args, { cwd: entry.path, encoding: 'utf-8' });
    diffFiles = output.trim().split('\n').filter(Boolean);
  } catch {
    return { error: 'Git diff failed. Is this a git repository?' };
  }
  if (diffFiles.length === 0) {
    return { changed_files: [], changed_count: 0, affected_count: 0, risk_level: 'none' };
  }

  const ctx = getRepo(entry.dbPath, name);
  if (!ctx.graph) ctx.graph = ctx.store.loadGraph();
  const graph = ctx.graph;

  const diffFileSet = new Set(diffFiles);
  const changedSymbols: string[] = [];
  const changedNodeIds = new Set<string>();
  for (const node of graph.iterNodes()) {
    const fp = node.properties.filePath as string | undefined;
    if (fp && diffFileSet.has(fp)) {
      changedNodeIds.add(node.id);
      changedSymbols.push(node.properties.name ?? node.id);
    }
  }

  const affectedProcesses: string[] = [];
  const seenProcessNames = new Set<string>();
  for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
    if (changedNodeIds.has(rel.targetId)) {
      const proc = graph.getNode(rel.sourceId);
      if (proc) {
        const procName = proc.properties.name ?? proc.id;
        if (!seenProcessNames.has(procName)) {
          seenProcessNames.add(procName);
          affectedProcesses.push(procName);
        }
      }
    }
  }

  return {
    changed_files: diffFiles,
    changed_count: diffFiles.length,
    affected_count: affectedProcesses.length,
    risk_level: affectedProcesses.length > 3 ? 'high' : affectedProcesses.length > 0 ? 'medium' : 'low',
    changed_symbols: changedSymbols,
    affected_processes: affectedProcesses,
  };
}

// ── Route dispatch ────────────────────────────────────────────────────────

type ToolHandler = (params: Record<string, unknown>) => unknown;

const TOOL_ROUTES: Record<string, ToolHandler> = {
  query: toolQuery,
  context: toolContext,
  impact: toolImpact,
  list_repos: toolListRepos,
  detect_changes: toolDetectChanges,
};

// ── Server ────────────────────────────────────────────────────────────────

export function startEvalServer(opts: EvalServerOptions = {}): Server {
  const port = opts.port ?? 4748;
  const host = opts.host ?? 'localhost';
  const idleTimeout = opts.idleTimeout ?? 300;

  let lastRequestTime = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function resetIdleTimer() {
    lastRequestTime = Date.now();
    if (idleTimer) clearTimeout(idleTimer);
    if (idleTimeout > 0) {
      idleTimer = setTimeout(() => {
        const elapsed = (Date.now() - lastRequestTime) / 1000;
        if (elapsed >= idleTimeout) {
          log.info('Eval server idle timeout reached, shutting down', { idleTimeout, elapsed: Math.round(elapsed) });
          shutdownEvalServer();
          server.close();
        }
      }, idleTimeout * 1000);
      idleTimer.unref(); // Don't keep process alive just for timer
    }
  }

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const path = url.pathname;

    try {
      // Health check — no auth required
      if (req.method === 'GET' && path === '/health') {
        resetIdleTimer();
        return json(res, { status: 'ok', uptime: process.uptime() });
      }

      // Tool endpoints: POST /tool/:name
      const toolMatch = path.match(/^\/tool\/([a-z_]+)$/);
      if (req.method === 'POST' && toolMatch) {
        resetIdleTimer();
        const toolName = toolMatch[1];
        const handler = TOOL_ROUTES[toolName];
        if (!handler) {
          return error(res, `Unknown tool: ${toolName}`, 404);
        }

        let body: Record<string, unknown>;
        try {
          body = await parseBody(req);
        } catch {
          return error(res, 'Invalid JSON body');
        }

        try {
          const result = handler === toolListRepos ? toolListRepos() : handler(body);
          return json(res, { result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return json(res, { error: message });
        }
      }

      // 404
      error(res, `Not found: ${req.method} ${path}`, 404);
    } catch (err) {
      if (err instanceof Error) {
        const body: Record<string, unknown> = { error: err.message, code: 'INTERNAL_ERROR' };
        if (process.env.NODE_ENV === 'development') {
          body.stack = err.stack;
        }
        json(res, body, 500);
      } else {
        error(res, String(err), 500);
      }
    }
  });

  server.listen(port, host, () => {
    log.info('Eval server started', { host, port, idleTimeout });
  });

  // Start idle timer
  resetIdleTimer();

  return server;
}

// ── Shutdown ────────────────────────────────────────────────────────────────

/**
 * Close all cached SQLite connections.
 * Call this on server shutdown to prevent WAL file locks.
 */
export function shutdownEvalServer(): void {
  for (const [, ctx] of repos) {
    ctx.store.close();
    ctx.fts.close();
    ctx.graph = undefined;
  }
  repos.clear();
}
