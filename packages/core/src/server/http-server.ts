/**
 * HTTP Server — REST API for Astrolabe knowledge graph (#262).
 *
 * Starts a local HTTP server exposing graph data via REST endpoints.
 * Supports web UI connectivity, Docker deployment, and headless integration.
 *
 * Uses Node.js built-in http module — no external dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join as pathJoin, resolve as pathResolve, dirname, basename, normalize, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { createSqliteStore } from '../persist/sqlite.js';
import { createFtsSearch } from '../search/fts.js';
import { loadRegistry } from '../mcp/registry.js';
import { loadMeta } from '../analysis/meta.js';
import { JobManager, type AnalyzeJob, type AnalyzeJobProgress } from './analyze-job.js';
import { chat as ragChat, type ChatMessage } from '../agent/rag-chat.js';
import { isAstrolabeError } from '@astrolabe-dev/shared';

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

// #485: Rate limiting — token bucket per IP
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_DEFAULT = 100; // requests per window

interface RateBucket { count: number; resetAt: number; }
const rateBuckets = new Map<string, RateBucket>();

function rateLimiter(req: IncomingMessage, res: ServerResponse): boolean {
  // Skip rate limiting for health endpoint
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/health') return true;

  const ip = req.socket.remoteAddress || 'unknown';
  const limit = parseInt(process.env.ASTROLABE_RATE_LIMIT || String(RATE_LIMIT_DEFAULT), 10);
  const now = Date.now();

  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }

  bucket.count++;
  const remaining = Math.max(0, limit - bucket.count);
  const resetSec = Math.ceil((bucket.resetAt - now) / 1000);

  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', resetSec);

  if (bucket.count > limit) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': _corsOrigin,
      'Retry-After': String(resetSec),
    });
    res.end(JSON.stringify({ error: 'Too many requests', retryAfter: resetSec }));
    return false;
  }

  return true;
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

/** Handle thrown errors — AstrolabeError produces structured response, others return 500 */
function handleError(res: ServerResponse, err: unknown) {
  if (isAstrolabeError(err)) {
    json(res, err.toJSON(), err.statusCode);
  } else if (err instanceof Error) {
    const body: Record<string, unknown> = { error: err.message, code: 'INTERNAL_ERROR' };
    if (process.env.NODE_ENV === 'development') {
      body.stack = err.stack;
    }
    json(res, body, 500);
  } else {
    json(res, { error: String(err), code: 'INTERNAL_ERROR' }, 500);
  }
}

// #471: Body size limit to prevent DoS (10 MB, same as MCP transport)
const MAX_BODY_SIZE = 10 * 1024 * 1024;

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
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
    handleError(res, err);
  }
}

async function handleClusters(res: ServerResponse, repoName: string) {
  const entries = loadRegistry();
  const entry = entries.find((e) => e.name === repoName);
  if (!entry) return error(res, `Repo "${repoName}" not found`, 404);

  try {
    const ctx = getRepo(entry.dbPath, repoName);
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
    handleError(res, err);
  }
}

async function handleGraph(res: ServerResponse, repoName: string, clusterId?: string) {
  const entries = loadRegistry();
  const entry = entries.find((e) => e.name === repoName);
  if (!entry) return error(res, `Repo "${repoName}" not found`, 404);

  try {
    const ctx = getRepo(entry.dbPath, repoName);
    if (!ctx.graph) ctx.graph = ctx.store.loadGraph();
    const graph = ctx.graph;

    const nodeLimit = 200;
    const edgeLimit = 400;
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    const memberIds = new Set<string>();

    // If cluster specified, collect its members first
    if (clusterId) {
      for (const rel of graph.iterRelationshipsByType('MEMBER_OF')) {
        if (rel.targetId === clusterId) memberIds.add(rel.sourceId);
      }
    }

    // Collect nodes (members first if cluster specified)
    for (const node of graph.iterNodes()) {
      if (nodes.length >= nodeLimit) break;
      if (clusterId && !memberIds.has(node.id)) continue;
      // Skip structural nodes
      if (node.label === 'File' || node.label === 'Folder') continue;
      nodes.push({
        id: node.id,
        label: node.label,
        name: node.properties.name ?? node.id,
        filePath: node.properties.filePath ?? '',
        startLine: node.properties.startLine ?? 0,
      });
    }

    // Collect edges between collected nodes
    const nodeIdSet = new Set(nodes.map((n: any) => n.id));
    for (const rel of graph.iterRelationships()) {
      if (edges.length >= edgeLimit) break;
      if (rel.type === 'CONTAINS') continue; // skip structural edges
      if (nodeIdSet.has(rel.sourceId) && nodeIdSet.has(rel.targetId)) {
        edges.push({
          sourceId: rel.sourceId,
          targetId: rel.targetId,
          type: rel.type,
          confidence: rel.confidence,
        });
      }
    }

    json(res, { nodes, edges, nodeCount: nodes.length, edgeCount: edges.length });
  } catch (err) {
    handleError(res, err);
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
    json(res, { results: results.map((r) => ({ label: r.label, name: r.name, filePath: r.filePath, rank: r.score })) });
  } catch (err) {
    handleError(res, err);
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
    handleError(res, err);
  }
}

async function handleGrep(res: ServerResponse, repoName: string, pattern: string, limit: number) {
  const entries = loadRegistry();
  const entry = entries.find((e) => e.name === repoName);
  if (!entry) return error(res, `Repo "${repoName}" not found`, 404);

  if (!pattern) return error(res, 'Missing pattern parameter');
  if (pattern.length > 200) return error(res, 'Pattern too long (max 200 characters)');

  // Escape regex special characters to prevent ReDoS injection
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let regex: RegExp;
  try {
    regex = new RegExp(escaped, 'gi');
  } catch {
    return error(res, 'Invalid regex pattern');
  }

  const safeLimit = Math.max(1, Math.min(200, limit));

  try {
    const ctx = getRepo(entry.dbPath, repoName);
    if (!ctx.graph) ctx.graph = ctx.store.loadGraph();
    const graph = ctx.graph;
    const repoRoot = entry.path;

    // Collect indexed file paths from graph
    const indexedFiles = new Set<string>();
    for (const node of graph.iterNodes()) {
      if (node.label === 'File' && node.properties.filePath) {
        indexedFiles.add(node.properties.filePath as string);
      }
    }

    // Search files on disk one at a time (constant memory)
    const results: Array<{ filePath: string; line: number; text: string }> = [];
    for (const filePath of indexedFiles) {
      if (results.length >= safeLimit) break;
      const fullPath = pathJoin(repoRoot, filePath);

      // Path traversal guard
      if (!fullPath.startsWith(repoRoot)) continue;
      if (!existsSync(fullPath)) continue;

      let content: string;
      try {
        content = readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= safeLimit) break;
        if (regex.test(lines[i])) {
          results.push({ filePath, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
        regex.lastIndex = 0;
      }
    }

    json(res, { matches: results.length, results });
  } catch (err) {
    handleError(res, err);
  }
}

// ── Job Manager (singleton) ────────────────────────────────────────────────

const jobManager = new JobManager();

// ── Analyze Handlers ──────────────────────────────────────────────────────

async function handleAnalyze(res: ServerResponse, params: Record<string, unknown>) {
  const repoPath = params.path as string | undefined;
  if (!repoPath) return error(res, 'Missing "path" in request body');

  // #479: Path validation — require absolute path, reject traversal sequences
  const normalized = normalize(repoPath);
  if (normalized.includes('..')) {
    return error(res, '"path" must not contain traversal sequences');
  }
  if (!isAbsolute(pathResolve(repoPath))) {
    return error(res, '"path" must be an absolute path');
  }
  if (!existsSync(repoPath as string)) {
    return error(res, `"${repoPath}" does not exist`);
  }

  const repoName = basename(repoPath);

  let job: AnalyzeJob;
  try {
    job = jobManager.createJob({ repoPath, repoName });
  } catch (e: any) {
    return error(res, e.message, 409);
  }

  // If job was already running (dedup), just return its id
  if (job.status !== 'queued') {
    return json(res, { jobId: job.id, status: job.status }, 202);
  }

  // Mark as active synchronously
  jobManager.updateJob(job.id, { status: 'analyzing', progress: { phase: 'analyzing', percent: 0, message: 'Starting analysis...' } });

  // Fork CLI child process for analysis
  // #480: Use fileURLToPath to handle Windows file:// URL correctly
  const __filename = fileURLToPath(import.meta.url);
  const cliDistPath = pathResolve(__filename, '..', '..', '..', 'cli', 'dist', 'index.js');
  const workerPath = existsSync(cliDistPath) ? cliDistPath : process.argv[1] ?? cliDistPath;

  const args = ['analyze', repoPath, '-o', pathJoin(repoPath, '.astrolabe', 'astrolabe.db')];
  const child = fork(workerPath, args, { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });

  jobManager.registerChild(job.id, child);

  // Parse progress from child stderr
  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString('utf-8');
    // Try to extract phase progress from log lines
    const phaseMatch = text.match(/(\w+)\s+(phase|complete)/i);
    if (phaseMatch) {
      jobManager.updateJob(job.id, {
        progress: { phase: phaseMatch[1].toLowerCase(), percent: 50, message: text.trim().slice(0, 200) },
      });
    }
  });

  child.on('message', (msg: any) => {
    if (msg?.type === 'progress') {
      jobManager.updateJob(job.id, { progress: msg });
    }
  });

  child.on('exit', (code) => {
    if (code === 0) {
      jobManager.updateJob(job.id, {
        status: 'complete',
        progress: { phase: 'complete', percent: 100, message: 'Analysis complete' },
      });
    } else {
      jobManager.updateJob(job.id, {
        status: 'failed',
        error: `Analysis exited with code ${code}`,
      });
    }
  });

  child.on('error', (err) => {
    jobManager.updateJob(job.id, {
      status: 'failed',
      error: err.message,
    });
  });

  json(res, { jobId: job.id, status: job.status }, 202);
}

function handleAnalyzeStatus(res: ServerResponse, jobId: string) {
  const job = jobManager.getJob(jobId);
  if (!job) return error(res, `Job "${jobId}" not found`, 404);
  json(res, { id: job.id, status: job.status, progress: job.progress, error: job.error, repoName: job.repoName, startedAt: job.startedAt, completedAt: job.completedAt });
}

function handleAnalyzeProgress(res: ServerResponse, jobId: string) {
  const job = jobManager.getJob(jobId);
  if (!job) return error(res, `Job "${jobId}" not found`, 404);

  let eventId = 0;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': _corsOrigin,
  });

  // Send current state immediately
  eventId++;
  res.write(`id: ${eventId}\ndata: ${JSON.stringify(job.progress)}\n\n`);

  // If already terminal, send event and close
  if (job.status === 'complete' || job.status === 'failed') {
    eventId++;
    res.write(`id: ${eventId}\nevent: ${job.status}\ndata: ${JSON.stringify({ repoName: job.repoName, error: job.error })}\n\n`);
    res.end();
    return;
  }

  // Heartbeat to detect zombie connections
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); unsubscribe(); }
  }, 30_000);

  // Subscribe to progress updates
  const unsubscribe = jobManager.onProgress(job.id, (progress: AnalyzeJobProgress) => {
    try {
      eventId++;
      if (progress.phase === 'complete' || progress.phase === 'failed') {
        const eventJob = jobManager.getJob(jobId);
        res.write(`id: ${eventId}\nevent: ${progress.phase}\ndata: ${JSON.stringify({ repoName: eventJob?.repoName, error: eventJob?.error })}\n\n`);
        clearInterval(heartbeat);
        res.end();
        unsubscribe();
      } else {
        res.write(`id: ${eventId}\ndata: ${JSON.stringify(progress)}\n\n`);
      }
    } catch {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
}

function handleAnalyzeCancel(res: ServerResponse, jobId: string) {
  const cancelled = jobManager.cancelJob(jobId);
  if (!cancelled) return error(res, `Job "${jobId}" not found or already complete`, 404);
  json(res, { id: jobId, status: 'cancelled' });
}

// ── NDJSON Streaming Handler ──────────────────────────────────────────────

async function handleGraphStream(res: ServerResponse, repoName: string) {
  const entries = loadRegistry();
  const entry = entries.find((e) => e.name === repoName);
  if (!entry) return error(res, `Repo "${repoName}" not found`, 404);

  try {
    const ctx = getRepo(entry.dbPath, repoName);
    if (!ctx.graph) ctx.graph = ctx.store.loadGraph();
    const graph = ctx.graph;

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': _corsOrigin,
    });

    // Stream nodes
    for (const node of graph.iterNodes()) {
      if (res.destroyed) break;
      const record = JSON.stringify({ type: 'node', data: { id: node.id, label: node.label, name: node.properties.name ?? node.id, filePath: node.properties.filePath ?? '', properties: node.properties } }) + '\n';
      const canContinue = res.write(record);
      if (!canContinue) await new Promise<void>((r) => res.once('drain', r));
    }

    // Stream relationships
    for (const rel of graph.iterRelationships()) {
      if (res.destroyed) break;
      const record = JSON.stringify({ type: 'relationship', data: { sourceId: rel.sourceId, targetId: rel.targetId, type: rel.type, confidence: rel.confidence, step: rel.step } }) + '\n';
      const canContinue = res.write(record);
      if (!canContinue) await new Promise<void>((r) => res.once('drain', r));
    }

    res.end();
  } catch (err) {
    if (!res.headersSent) {
      handleError(res, err);
    } else {
      try { res.write(JSON.stringify({ type: 'error', error: String(err) }) + '\n'); } catch { /* best effort */ }
      res.end();
    }
  }
}

// ── Server ────────────────────────────────────────────────────────────────

// ── Chat Handler ──────────────────────────────────────────────────────────

async function handleChat(res: ServerResponse, params: Record<string, unknown>) {
  const message = params.message as string;
  if (!message) return error(res, 'Missing "message" in request body');

  const repo = params.repo as string | undefined;
  const history = (params.history as Array<{ role: string; content: string }>) ?? [];

  const messages: ChatMessage[] = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  messages.push({ role: 'user', content: message });

  try {
    const result = await ragChat(messages, { repo });
    json(res, result);
  } catch (err: any) {
    handleError(res, err);
  }
}

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
    // #483: Request tracing — generate or preserve request ID
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('X-Request-Id', requestId);

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

    // #383: Health check must skip auth for bridge auto-detection
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const path = url.pathname;

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

    // #485: Rate limiting
    if (!rateLimiter(req, res)) return;

    // #329: Auth middleware
    if (!authMiddleware(req, res)) return;

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

      // GET /api/repo/:name/graph[?cluster=id] — graph data for visualization (#372)
      const grMatch = path.match(/^\/api\/repo\/([^/]+)\/graph$/);
      if (req.method === 'GET' && grMatch) {
        const clusterId = url.searchParams.get('cluster') ?? undefined;
        return await handleGraph(res, decodeURIComponent(grMatch[1]), clusterId);
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

      // GET /api/repo/:name/grep?pattern=...&limit=...
      const grepMatch = path.match(/^\/api\/repo\/([^/]+)\/grep$/);
      if (req.method === 'GET' && grepMatch) {
        const pattern = url.searchParams.get('pattern') ?? '';
        const parsedLimit = Number(url.searchParams.get('limit') ?? 50);
        const safeLimit = Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : 50;
        return await handleGrep(res, decodeURIComponent(grepMatch[1]), pattern, safeLimit);
      }

      // GET /api/repo/:name/graph/stream — NDJSON streaming graph export
      const gsMatch = path.match(/^\/api\/repo\/([^/]+)\/graph\/stream$/);
      if (req.method === 'GET' && gsMatch) {
        return await handleGraphStream(res, decodeURIComponent(gsMatch[1]));
      }

      // ── Analyze Job API ──────────────────────────────────────────────

      // POST /api/chat — RAG chat endpoint
      if (req.method === 'POST' && path === '/api/chat') {
        const body = await parseBody(req);
        return await handleChat(res, body);
      }

      // POST /api/analyze — start analysis job
      if (req.method === 'POST' && path === '/api/analyze') {
        const body = await parseBody(req);
        return await handleAnalyze(res, body);
      }

      // GET /api/analyze/:jobId — poll job status
      const ajMatch = path.match(/^\/api\/analyze\/([^/]+)$/);
      if (req.method === 'GET' && ajMatch) {
        return handleAnalyzeStatus(res, decodeURIComponent(ajMatch[1]));
      }

      // GET /api/analyze/:jobId/progress — SSE stream
      const apMatch = path.match(/^\/api\/analyze\/([^/]+)\/progress$/);
      if (req.method === 'GET' && apMatch) {
        return handleAnalyzeProgress(res, decodeURIComponent(apMatch[1]));
      }

      // DELETE /api/analyze/:jobId — cancel job
      if (req.method === 'DELETE' && ajMatch) {
        return handleAnalyzeCancel(res, decodeURIComponent(ajMatch[1]));
      }

      // 404
      error(res, `Not found: ${req.method} ${path}`, 404);
    } catch (err) {
      handleError(res, err);
    }
  });

  server.listen(port, host, () => {
    console.error(`Astrolabe HTTP server listening on http://${host}:${port}`);
    console.error(`API docs: http://${host}:${port}/api/repos`);
  });

  // #332: Graceful shutdown — drain active connections before exit (#495)
  let shuttingDown = false;
  let activeRequests = 0;

  server.on('request', (_req: IncomingMessage, res: ServerResponse) => {
    activeRequests++;
    if (shuttingDown) res.setHeader('Connection', 'close');
    res.on('finish', () => { activeRequests--; });
    res.on('close', () => { activeRequests--; });
  });

  const DRAIN_TIMEOUT_MS = 10_000;
  const cleanup = () => {
    if (shuttingDown) return; // Prevent double-shutdown
    shuttingDown = true;
    console.error(`Astrolabe: shutting down, draining ${activeRequests} active requests...`);

    jobManager.dispose();
    shutdownHttpServer();
    server.close(); // Stop accepting new connections

    // Force exit after drain timeout
    setTimeout(() => {
      if (activeRequests > 0) {
        console.error(`Astrolabe: forcing exit, ${activeRequests} requests still active`);
      }
      process.exit(activeRequests > 0 ? 1 : 0);
    }, DRAIN_TIMEOUT_MS);

    // Exit immediately if no active requests
    if (activeRequests === 0) {
      process.exit(0);
    }
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
