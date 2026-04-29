/**
 * MCP Server for Astrolabe.
 *
 * Full Model Context Protocol server (JSON-RPC over stdio) with 7 working
 * tools backed by the SQLite knowledge graph database and a global registry
 * for multi-repo support.
 *
 * Tools: list_repos, query, context, impact, detect_changes, filter_by_label
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { createSqliteStore } from '../persist/sqlite.js';
import { createFtsSearch } from '../search/fts.js';
import type { SqliteStore } from '../persist/sqlite.js';
import type { FtsSearch } from '../search/fts.js';
import type { GraphNode } from '../core/types.js';
import { loadRegistry, type RegistryEntry } from './registry.js';
import { listGroups, getGroupStatus, groupQuery } from './groups.js';
import { syncGroupContracts, getGroupContracts } from './contracts.js';
import { McpTransport } from './transport.js';
import { routeMap, toolMap, apiImpact, shapeCheck } from './api-tools.js';
import { executeTraversal, type TraversalQuery } from './traverse.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface GraphTraversalQuery {
  match?: { label?: string; filter?: Record<string, unknown>; id?: string };
  traverse?: Array<{
    direction: 'incoming' | 'outgoing' | 'any';
    type?: string;
    filter?: Record<string, unknown>;
    nodeFilter?: { label?: string; filter?: Record<string, unknown> };
  }>;
  return?: string[];
  limit?: number;
  repo?: string;
}

/** Check if a property bag matches a filter spec. Supports gt/gte/lt/lte operators. */
function matchesFilter(props: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [key, expected] of Object.entries(filter)) {
    const actual = props[key];
    if (expected === null || expected === undefined) {
      if (actual != null) return false;
    } else if (typeof expected === 'object' && !Array.isArray(expected)) {
      // Operator object: { gt: 0.8 }, { lt: 10 }, etc.
      const op = expected as Record<string, number>;
      if (op.gt !== undefined && (typeof actual !== 'number' || actual <= op.gt)) return false;
      if (op.gte !== undefined && (typeof actual !== 'number' || actual < op.gte)) return false;
      if (op.lt !== undefined && (typeof actual !== 'number' || actual >= op.lt)) return false;
      if (op.lte !== undefined && (typeof actual !== 'number' || actual > op.lte)) return false;
    } else {
      if (actual !== expected) return false;
    }
  }
  return true;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RepoContext {
  store: SqliteStore;
  fts: FtsSearch;
  entry: RegistryEntry;
  /** Cached knowledge graph — invalidate with invalidateGraph() on changes (#176). */
  graph?: import('../core/types.js').KnowledgeGraph;
  loadGraph(): import('../core/types.js').KnowledgeGraph;
  invalidateGraph(): void;
}

function createRepoContext(store: SqliteStore, fts: FtsSearch, entry: RegistryEntry): RepoContext {
  let lastMtime = 0;

  return {
    store,
    fts,
    entry,
    graph: undefined,
    loadGraph() {
      // #240: Check DB file mtime to detect stale cache after external re-analysis
      try {
        const mtime = statSync(entry.dbPath).mtimeMs;
        if (this.graph && lastMtime >= mtime) return this.graph;
        lastMtime = mtime;
      } catch { /* file missing — will fail on store.loadGraph() below */ }

      this.graph = store.loadGraph();
      return this.graph;
    },
    invalidateGraph() {
      this.graph = undefined;
    },
  };
}

// ── Backend ────────────────────────────────────────────────────────────────

class LocalBackend {
  private repos = new Map<string, RepoContext>();
  private maxConns = 5;
  private lastAccess = new Map<string, number>();

  getRepo(repoParam?: string): RepoContext {
    const entries = loadRegistry();
    const name = repoParam ?? entries[0]?.name;
    if (!name) throw new Error('No indexed repositories. Run `astrolabe analyze` first.');

    // Check cache
    let ctx = this.repos.get(name);
    if (ctx) {
      this.lastAccess.set(name, Date.now());
      return ctx;
    }

    // Find entry
    const entry = entries.find((e) => e.name === name);
    if (!entry) throw new Error(`Repository "${name}" not found. Available: ${entries.map((e) => e.name).join(', ')}`);

    // Evict if too many connections
    if (this.repos.size >= this.maxConns) {
      let oldest = '';
      let oldestTime = Infinity;
      for (const [n, t] of this.lastAccess) {
        if ((t ?? 0) < oldestTime) { oldest = n; oldestTime = t ?? 0; }
      }
      if (oldest && this.repos.has(oldest)) {
        this.repos.get(oldest)!.store.close();
        this.repos.get(oldest)!.fts.close();
        this.repos.delete(oldest);
        this.lastAccess.delete(oldest);
      } else if (oldest) {
        // #301: Clean stale lastAccess entry with no corresponding repo
        this.lastAccess.delete(oldest);
      }
    }

    // Open connection
    const store = createSqliteStore(entry.dbPath);
    const fts = createFtsSearch(entry.dbPath);
    ctx = createRepoContext(store, fts, entry);
    this.repos.set(name, ctx);
    this.lastAccess.set(name, Date.now());
    return ctx;
  }

  listRepos(): RegistryEntry[] {
    return loadRegistry();
  }

  query(query: string, repo?: string, limit = 20) {
    const ctx = this.getRepo(repo);
    const results = ctx.fts.search(query, limit);
    if (results.length === 0) return { definitions: [], processes: [], process_symbols: [] };

    // Load graph for process grouping
    const graph = ctx.loadGraph();

    // Group by process membership
    const nodeSet = new Set(results.map((r) => r.nodeId));
    const processMap = new Map<string, { process: GraphNode; symbols: GraphNode[] }>();

    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      if (nodeSet.has(rel.targetId)) {
        const proc = graph.getNode(rel.sourceId);
        const sym = graph.getNode(rel.targetId);
        if (!proc || !sym) continue;
        let p = processMap.get(proc.id);
        if (!p) { p = { process: proc, symbols: [] }; processMap.set(proc.id, p); }
        if (!p.symbols.find((s) => s.id === sym.id)) p.symbols.push(sym);
      }
    }

    const processes = Array.from(processMap.values()).map((p) => ({
      summary: p.process.properties.name ?? p.process.id,
      priority: 0.042,
      symbol_count: p.symbols.length,
      process_type: (p.process.properties.processType as string) ?? 'intra_community',
      step_count: (p.process.properties.stepCount as number) ?? 0,
    }));

    const processSymbols = Array.from(processMap.values()).flatMap((p) =>
      p.symbols.map((s) => ({
        name: s.properties.name ?? s.id,
        type: s.label,
        filePath: s.properties.filePath ?? '',
        process_id: p.process.id,
      })),
    );

    const defNodeIds = new Set(processSymbols.map((s) => `${s.filePath}:${s.name}`));
    const definitions = results
      .filter((r) => !defNodeIds.has(`${r.filePath}:${r.name}`))
      .map((r) => ({ name: r.name, type: r.label, filePath: r.filePath }));

    return { processes, process_symbols: processSymbols, definitions };
  }

  context(nameOrUid: string, repo?: string) {
    const ctx = this.getRepo(repo);
    const graph = ctx.loadGraph();

    // Find ALL matching symbols (handle overloads) (#116)
    const symbols: GraphNode[] = [];
    for (const node of graph.iterNodes()) {
      if (node.id === nameOrUid || node.properties.name === nameOrUid) {
        symbols.push(node);
      }
    }
    if (symbols.length === 0) return { error: `Symbol "${nameOrUid}" not found.` };

    // #177: Build adjacency index ONCE for all symbols (O(R) not O(S × R))
    const incomingMap = new Map<string, Map<string, string[]>>();
    const outgoingMap = new Map<string, Map<string, string[]>>();

    for (const rel of graph.iterRelationships()) {
      if (rel.type !== 'STEP_IN_PROCESS') {
        // Incoming edge
        let inc = incomingMap.get(rel.targetId);
        if (!inc) { inc = new Map(); incomingMap.set(rel.targetId, inc); }
        const incType = rel.type.toLowerCase();
        let incNames = inc.get(incType);
        if (!incNames) { incNames = []; inc.set(incType, incNames); }
        incNames.push(graph.getNode(rel.sourceId)?.properties.name as string ?? rel.sourceId);

        // Outgoing edge
        let out = outgoingMap.get(rel.sourceId);
        if (!out) { out = new Map(); outgoingMap.set(rel.sourceId, out); }
        const outType = rel.type.toLowerCase();
        let outNames = out.get(outType);
        if (!outNames) { outNames = []; out.set(outType, outNames); }
        outNames.push(graph.getNode(rel.targetId)?.properties.name as string ?? rel.targetId);
      }
    }

    // Process index: build once for all symbols
    const processMap = new Map<string, Array<{ name: string; step: number; total: number }>>();
    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      const proc = graph.getNode(rel.sourceId);
      if (!proc) continue;
      let arr = processMap.get(rel.targetId);
      if (!arr) { arr = []; processMap.set(rel.targetId, arr); }
      arr.push({
        name: (proc.properties.name as string) ?? proc.id,
        step: rel.step ?? 0,
        total: (proc.properties.stepCount as number) ?? 0,
      });
    }

    const results = symbols.map((symbol) => {
      const inc = incomingMap.get(symbol.id);
      const incoming: Record<string, string[]> = {};
      if (inc) { for (const [t, names] of inc) incoming[t] = names; }

      const out = outgoingMap.get(symbol.id);
      const outgoing: Record<string, string[]> = {};
      if (out) { for (const [t, names] of out) outgoing[t] = names; }

      const processes = processMap.get(symbol.id) ?? [];

      // TODO(#164): Include resolved type information once parser captures
      // returnType/declaredType on Function/Method nodes and cross-file
      // phase produces resolved_returnType.
      const symbolInfo: Record<string, unknown> = {
        uid: symbol.id,
        kind: symbol.label,
        name: (symbol.properties.name as string) ?? '',
        filePath: symbol.properties.filePath ?? '',
        startLine: symbol.properties.startLine ?? 0,
      };

      return {
        symbol: symbolInfo,
        incoming,
        outgoing,
        processes,
      };
    });

    return { match_count: results.length, matches: results };
  }

  impact(target: string, direction: 'upstream' | 'downstream' = 'upstream', repo?: string, maxDepth = 5, minConfidence = 0.3) {
    const ctx = this.getRepo(repo);
    const graph = ctx.loadGraph();

    // Find target symbol
    let targetNode: GraphNode | undefined;
    for (const node of graph.iterNodes()) {
      if (node.id === target || node.properties.name === target) {
        targetNode = node;
        break;
      }
    }
    if (!targetNode) return { error: `Target "${target}" not found.` };

    // Pre-build adjacency index: Map<nodeId, { neighborId, type, confidence }[]> (#119)
    const adj = new Map<string, Array<{ neighborId: string; type: string; confidence: number }>>();
    for (const rel of graph.iterRelationships()) {
      // #290: Exclude synthetic STEP_IN_PROCESS edges — being in same process ≠ dependency
      if (rel.type === 'STEP_IN_PROCESS') continue;
      if (rel.confidence < minConfidence) continue;
      // Upstream: target <- source (who calls me)
      if (direction === 'upstream') {
        let bucket = adj.get(rel.targetId);
        if (!bucket) { bucket = []; adj.set(rel.targetId, bucket); }
        bucket.push({ neighborId: rel.sourceId, type: rel.type, confidence: rel.confidence });
      } else {
        // Downstream: source -> target (who I call)
        let bucket = adj.get(rel.sourceId);
        if (!bucket) { bucket = []; adj.set(rel.sourceId, bucket); }
        bucket.push({ neighborId: rel.targetId, type: rel.type, confidence: rel.confidence });
      }
    }

    // BFS traversal using adjacency index (#248: cap total results to prevent OOM)
    const MAX_IMPACT_RESULTS = 500;
    const affected: Array<{ depth: number; name: string; type: string; filePath: string; relationType: string; confidence: number }> = [];
    const visited = new Set<string>([targetNode.id]);
    const queue: Array<{ id: string; depth: number }> = [{ id: targetNode.id, depth: 0 }];
    let truncated = false;

    while (queue.length > 0 && affected.length < MAX_IMPACT_RESULTS) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const neighbors = adj.get(current.id) ?? [];
      for (const { neighborId, type, confidence } of neighbors) {
        if (visited.has(neighborId)) continue;
        if (affected.length >= MAX_IMPACT_RESULTS) { truncated = true; break; }
        visited.add(neighborId);
        const node = graph.getNode(neighborId);
        queue.push({ id: neighborId, depth: current.depth + 1 });
        affected.push({
          depth: current.depth + 1,
          name: node?.properties.name ?? neighborId,
          type: node?.label ?? 'unknown',
          filePath: (node?.properties.filePath as string) ?? '',
          relationType: type,
          confidence,
        });
      }
    }

    // Group by depth with risk levels
    const depthGroups: Record<string, { risk: string; items: typeof affected }> = {};
    for (const item of affected) {
      const key = `depth_${item.depth}`;
      if (!depthGroups[key]) {
        depthGroups[key] = { risk: item.depth === 1 ? 'WILL BREAK' : item.depth === 2 ? 'LIKELY AFFECTED' : 'MAYBE AFFECTED', items: [] };
      }
      depthGroups[key].items.push(item);
    }

    return {
      target: { name: targetNode.properties.name ?? targetNode.id, type: targetNode.label, filePath: targetNode.properties.filePath ?? '' },
      direction,
      affected_count: affected.length,
      truncated, // #248: true if result cap reached
      depth_groups: depthGroups,
    };
  }

  detectChanges(scope: 'unstaged' | 'staged' | 'all' = 'unstaged', repo?: string) {
    // Validate scope parameter (#118)
    const validScopes = ['unstaged', 'staged', 'all'];
    if (!validScopes.includes(scope)) {
      return { error: `Invalid scope "${scope}". Use: ${validScopes.join(', ')}` };
    }

    const ctx = this.getRepo(repo);
    // Invalidate cached graph since changes may have occurred (#176)
    ctx.invalidateGraph();
    const repoPath = ctx.entry.path;

    let diffFiles: string[] = [];
    try {
      const diffFlag = scope === 'staged' ? '--cached' : scope === 'all' ? 'HEAD' : '';
      const args = ['diff', '--name-only'];
      if (diffFlag) args.push(diffFlag);
      const output = execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' });
      diffFiles = output.trim().split('\n').filter(Boolean);
    } catch {
      return { error: 'Git diff failed. Is this a git repository?' };
    }
    if (diffFiles.length === 0) return { changed_files: [], changed_count: 0, affected_count: 0, risk_level: 'none' };

    const graph = ctx.loadGraph();

    const changedSymbols: string[] = [];
    const affectedProcesses: string[] = [];

    // #314: Use Set for O(N+M) file matching instead of Array.includes O(N*M)
    const changedNodeIds = new Set<string>();
    const diffFileSet = new Set(diffFiles);
    for (const node of graph.iterNodes()) {
      const fp = node.properties.filePath as string | undefined;
      if (fp && diffFileSet.has(fp)) {
        changedNodeIds.add(node.id);
        changedSymbols.push(node.properties.name ?? node.id);
      }
    }

    // Find affected processes by matching STEP_IN_PROCESS targets by node ID
    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      if (changedNodeIds.has(rel.targetId)) {
        const proc = graph.getNode(rel.sourceId);
        if (proc && !affectedProcesses.includes(proc.properties.name ?? proc.id)) {
          affectedProcesses.push(proc.properties.name ?? proc.id);
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

  renameSymbol(symbolName: string, newName: string, filePath?: string, dryRun = true, repo?: string) {
    // #174: Actual renaming is not implemented yet
    if (!dryRun) {
      throw new Error('Live renaming is not implemented yet. Use dry_run=true for preview only.');
    }

    const ctx = this.getRepo(repo);
    const graph = ctx.loadGraph();

    // Find all references
    const refs: Array<{ name: string; id: string; filePath: string; matchType: 'graph' | 'text_search' }> = [];

    for (const node of graph.iterNodes()) {
      if (filePath && node.properties.filePath !== filePath) continue;
      if (node.properties.name === symbolName) {
        refs.push({ name: node.properties.name ?? '', id: node.id, filePath: (node.properties.filePath as string) ?? '', matchType: 'graph' });
      }
    }

    return {
      status: 'preview',
      files_affected: new Set(refs.map((r) => r.filePath)).size,
      total_edits: refs.length,
      graph_edits: refs.filter((r) => r.matchType === 'graph').length,
      text_search_edits: 0,
      dry_run: dryRun,
      changes: refs.map((r) => ({
        file: r.filePath,
        node_id: r.id,
        old_name: r.name,
        new_name: newName,
        confidence: r.matchType,
      })),
    };
  }

  filterByLabel(label: string, repo?: string) {
    const ctx = this.getRepo(repo);
    const graph = ctx.loadGraph();

    // #243: Renamed from "cypher" — this only does single-label filtering,
    // not actual Cypher graph pattern matching.
    const results: Array<Record<string, unknown>> = [];
    for (const node of graph.iterNodes()) {
      if (node.label !== label) continue;
      results.push({
        id: node.id,
        label: node.label,
        name: node.properties.name,
        filePath: node.properties.filePath,
      });
    }
    return { columns: ['id', 'label', 'name', 'filePath'], rows: results };
  }

  // ── Graph Traversal Query Engine (#369) ───────────────────────────────

  /**
   * JSON-based graph traversal engine.
   *
   * Supports: node-pattern matching → relationship traversal chains →
   * property filtering → limited returns.
   *
   * Query shape:
   * {
   *   match: { label?: string, filter?: { name: "..." }, id?: string },
   *   traverse: [{ direction: "incoming"|"outgoing"|"any", type?: "CALLS",
   *               filter?: { confidence: { gt: 0.8 } } }],
   *   return: ["name", "filePath"],
   *   limit: 50
   * }
   */
  graphQuery(query: GraphTraversalQuery, repo?: string) {
    const ctx = this.getRepo(repo);
    const graph = ctx.loadGraph();
    const limit = query.limit ?? 50;

    // Step 1: Match starting nodes
    let currentIds: Set<string>;
    if (query.match?.id) {
      currentIds = new Set([query.match.id]);
    } else {
      currentIds = new Set<string>();
      for (const node of graph.iterNodes()) {
        if (query.match?.label && node.label !== query.match.label) continue;
        if (!matchesFilter(node.properties, query.match?.filter)) continue;
        currentIds.add(node.id);
        if (currentIds.size >= limit * 3) break; // safety cap on match phase
      }
    }

    if (currentIds.size === 0) return { columns: [], rows: [] };

    // Step 2: Traverse relationships (chain of steps)
    if (query.traverse) {
      for (const step of query.traverse) {
        const nextIds = new Set<string>();
        for (const rel of graph.iterRelationships()) {
          const isMatch = step.direction === 'any'
            ? (currentIds.has(rel.sourceId) || currentIds.has(rel.targetId))
            : step.direction === 'outgoing'
              ? currentIds.has(rel.sourceId)
              : currentIds.has(rel.targetId);

          if (!isMatch) continue;
          if (step.type && rel.type !== step.type) continue;
          if (!matchesFilter(rel as unknown as Record<string, unknown>, step.filter)) continue;

          const neighborId = step.direction === 'outgoing'
            ? rel.targetId
            : step.direction === 'incoming'
              ? rel.sourceId
              : currentIds.has(rel.sourceId) ? rel.targetId : rel.sourceId;

          // Apply node-level filter on the neighbor
          const neighbor = graph.getNode(neighborId);
          if (!neighbor) continue;
          if (step.nodeFilter?.label && neighbor.label !== step.nodeFilter.label) continue;
          if (!matchesFilter(neighbor.properties, step.nodeFilter?.filter)) continue;

          nextIds.add(neighborId);
          if (nextIds.size >= limit) break;
        }
        currentIds = nextIds;
        if (currentIds.size === 0) break;
      }
    }

    // Step 3: Collect results with requested properties
    const columns = query.return ?? ['id', 'label', 'name', 'filePath'];
    const rows: Array<Record<string, unknown>> = [];
    for (const id of currentIds) {
      const node = graph.getNode(id);
      if (!node) continue;
      const row: Record<string, unknown> = {};
      for (const col of columns) {
        if (col === 'id') row.id = node.id;
        else if (col === 'label') row.label = node.label;
        else row[col] = node.properties[col] ?? null;
      }
      rows.push(row);
      if (rows.length >= limit) break;
    }

    return { columns, rows, total_matched: currentIds.size, returned: rows.length };
  }

  shutdown(): void {
    for (const ctx of this.repos.values()) {
      ctx.store.close();
      ctx.fts.close();
    }
    // #301: Also clear lastAccess to prevent stale entry divergence
    this.repos.clear();
    this.lastAccess.clear();
  }
}

// ── Tool definitions ───────────────────────────────────────────────────────

const backend = new LocalBackend();

// #241: Validate required string/number parameters to prevent uncaught exceptions
function requireString(params: Record<string, unknown>, key: string): string {
  const val = params[key];
  if (typeof val !== 'string' || val.length === 0) throw new Error(`Missing or invalid parameter: ${key}`);
  return val;
}
function requireNumber(params: Record<string, unknown>, key: string, fallback: number): number {
  const val = params[key];
  if (val === undefined || val === null) return fallback;
  if (typeof val !== 'number') throw new Error(`Invalid parameter: ${key} (expected number, got ${typeof val})`);
  return val;
}

const TOOLS: Record<string, {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}> = {
  'astrolabe.list_repos': {
    name: 'astrolabe.list_repos',
    description: 'Discover all indexed repositories. Read this first before using other tools.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const repos = backend.listRepos();
      if (repos.length === 0) return { content: [{ type: 'text', text: 'No indexed repositories. Run `astrolabe analyze <path>` first.' }] };
      const lines = repos.map((r) => `${r.name} (${r.path}) — ${new Date(r.indexedAt).toISOString()}`);
      return { content: [{ type: 'text', text: `Indexed repositories:\n${lines.join('\n')}\n\nNext: use query({query: "your search"}) or context({name: "symbolName"}). For complex graph patterns, use cypher({match: {...}}). Read astrolabe://repo/{name}/schema for node labels and relationship types.` }] };
    },
  },

  'astrolabe.query': {
    name: 'astrolabe.query',
    description: 'Hybrid search over the knowledge graph. Returns process-grouped results for architectural context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (symbol name, concept, etc.)' },
        limit: { type: 'number', description: 'Max results', default: 20 },
        repo: { type: 'string', description: 'Repository name (optional if only one indexed)' },
      },
      required: ['query'],
    },
    handler: async (params) => {
      const query = requireString(params, 'query');
      const result = backend.query(query, params.repo as string, requireNumber(params, 'limit', 20));
      const nextHint = '\n\nNext: use context({name: "foundSymbol"}) to get 360-degree view of any result.';
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.context': {
    name: 'astrolabe.context',
    description: '360-degree symbol view — callers, callees, process membership for one symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name or node ID' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['name'],
    },
    handler: async (params) => {
      const name = requireString(params, 'name');
      const result = backend.context(name, params.repo as string);
      const nextHint = '\n\nNext: use impact({target: "symbolName", direction: "upstream"}) for blast radius analysis.';
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.impact': {
    name: 'astrolabe.impact',
    description: 'Blast radius analysis — what depends on this symbol, and what depends on those? Grouped by depth with risk levels.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Symbol name or node ID to analyze' },
        direction: { type: 'string', enum: ['upstream', 'downstream'], default: 'upstream' },
        maxDepth: { type: 'number', description: 'How many levels to traverse', default: 5 },
        minConfidence: { type: 'number', description: 'Minimum edge confidence (0.0-1.0)', default: 0.3 },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['target'],
    },
    handler: async (params) => {
      const target = requireString(params, 'target');
      const result = backend.impact(
        target,
        (params.direction as 'upstream' | 'downstream') ?? 'upstream',
        params.repo as string,
        requireNumber(params, 'maxDepth', 5),
        requireNumber(params, 'minConfidence', 0.3),
      );
      const nextHint = '\n\nNext: use detect_changes() before committing to verify your changes match expected impact.';
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.detect_changes': {
    name: 'astrolabe.detect_changes',
    description: 'Git-diff impact — maps changed files to affected symbols and processes.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['unstaged', 'staged', 'all'], default: 'unstaged' },
        repo: { type: 'string', description: 'Repository name' },
      },
    },
    handler: async (params) => {
      const result = backend.detectChanges((params.scope as 'unstaged' | 'staged' | 'all') ?? 'unstaged', params.repo as string);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },

  'astrolabe.rename': {
    name: 'astrolabe.rename',
    description: '[PREVIEW ONLY] Graph-assisted multi-file rename preview. Does not perform actual renames.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string', description: 'Current symbol name' },
        new_name: { type: 'string', description: 'New name for the symbol' },
        file_path: { type: 'string', description: 'Limit to specific file (optional)' },
        dry_run: { type: 'boolean', description: 'Preview without modifying files', default: true },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['symbol_name', 'new_name'],
    },
    handler: async (params) => {
      // #291: Validate required params via requireString — was as string cast
      const symbolName = requireString(params, 'symbol_name');
      const newName = requireString(params, 'new_name');
      const result = backend.renameSymbol(
        symbolName, newName,
        params.file_path as string,
        (params.dry_run as boolean) ?? true,
        params.repo as string,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },

  'astrolabe.filter_by_label': {
    name: 'astrolabe.filter_by_label',
    description: 'Filter graph nodes by label type (e.g., Function, Class, Route). Returns matching nodes with id, label, name, and filePath.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Node label to filter by (e.g. "Function", "Class")' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['label'],
    },
    handler: async (params) => {
      const label = requireString(params, 'label');
      const result = backend.filterByLabel(label, params.repo as string);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },

  'astrolabe.cypher': {
    name: 'astrolabe.cypher',
    description: `Graph traversal queries over the knowledge graph. Chain-match nodes and traverse edges.

QUERY FORMAT:
{
  "query": {
    "match": { "label": "Function" },         // optional: filter start nodes by label/name/id
    "traverse": [                              // optional: chain of edge walks
      { "direction": "incoming", "type": "CALLS", "minConfidence": 0.8 },
      { "direction": "outgoing", "type": "MEMBER_OF" }
    ],
    "limit": 50                                // optional: max results (default 50)
  }
}
If match is omitted, starts from all nodes (limited to prevent OOM).

EXAMPLES:
- All classes: { query: { match: { label: "Class" } } }
- What calls validateUser: { query: { match: { name: "validateUser" }, traverse: [{ direction: "incoming", type: "CALLS" }] } }
- Call chain from auth: { query: { match: { name: "Authentication", label: "Community" }, traverse: [{ direction: "incoming", type: "MEMBER_OF" }, { direction: "outgoing", type: "CALLS" }] } }

RETURNS: { nodes: [...], edges: [...], nodeCount, edgeCount }`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'object', description: 'Traversal query object with match, traverse[], and limit' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['query'],
    },
    handler: async (params) => {
      const query = params.query as TraversalQuery;
      if (!query) throw new Error('Missing required parameter: query');
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const result = executeTraversal(graph, query);
      const nextHint = '\n\nNext: use context({name: "<symbol>"}) for 360-degree view of any result node.';
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.group_list': {
    name: 'astrolabe.group_list',
    description: 'List all cross-repo groups. Use this to discover monorepo/multi-service groupings.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const groups = listGroups();
      if (groups.length === 0) return { content: [{ type: 'text', text: 'No groups defined. Use `astrolabe group create <name>` from CLI to create one.' }] };
      const lines = groups.map((g) => `${g.name} (${Object.keys(g.repos).length} repos, created ${new Date(g.createdAt).toISOString()})`);
      return { content: [{ type: 'text', text: `Groups:\n${lines.join('\n')}\n\nNext: use group_status({name: "groupName"}) to check staleness.` }] };
    },
  },

  'astrolabe.group_status': {
    name: 'astrolabe.group_status',
    description: 'Check staleness and status of all repos in a cross-repo group.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Group name from group_list' } },
      required: ['name'],
    },
    handler: async (params) => {
      const name = requireString(params, 'name');
      const status = getGroupStatus(name);
      const lines = status.repos.map((r) => {
        const icon = r.stale ? '⚠ STALE' : '✓ current';
        const indexed = r.indexedAt ? new Date(r.indexedAt).toISOString() : 'never';
        return `${icon} | ${r.path} → ${r.repoName} (last indexed: ${indexed})`;
      });
      return { content: [{ type: 'text', text: `Group: ${status.name} (${status.repoCount} repos)\n${lines.join('\n')}` }] };
    },
  },

  'astrolabe.group_query': {
    name: 'astrolabe.group_query',
    description: 'Search across all repos in a cross-repo group. Fans out to each repo database.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        query: { type: 'string', description: 'Search term' },
        limit: { type: 'number', description: 'Max results per repo', default: 20 },
      },
      required: ['name', 'query'],
    },
    handler: async (params) => {
      const groupName = requireString(params, 'name');
      const query = requireString(params, 'query');
      const limit = requireNumber(params, 'limit', 20);
      const results = groupQuery(groupName, query, limit);
      if (results.length === 0) return { content: [{ type: 'text', text: 'No results or no reachable databases in the group.' }] };
      const lines = results.map((r) => {
        const repoResults = r.results.map((rr) => `  ${rr.label.padEnd(12)} ${rr.name.padEnd(30)} ${rr.filePath}`).join('\n');
        return `=== ${r.repoName} ===\n${repoResults}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
    },
  },

  'astrolabe.group_sync': {
    name: 'astrolabe.group_sync',
    description: `Extract HTTP API contracts from all repos in a group and cross-link providers to consumers.

Detects:
- Providers: Route handlers (Express, Flask, Laravel, etc.) from Route nodes
- Consumers: HTTP client calls (fetch, axios, got, request, httpClient) from Function nodes
- Cross-links: Matches consumers to providers across repo boundaries by path similarity

Results are persisted in the group config for subsequent group_contracts queries.
AFTER THIS: use group_contracts({name: "groupName"}) to inspect extracted contracts.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name from group_list' },
      },
      required: ['name'],
    },
    handler: async (params) => {
      const name = requireString(params, 'name');
      const results = syncGroupContracts(name);
      const lines = results.map((r) => {
        const icon = r.error ? '✗ ERROR' : '✓';
        return `${icon} | ${r.repoName}: ${r.providerCount} providers, ${r.consumerCount} consumers, ${r.crossLinks} cross-links${r.error ? ` (${r.error})` : ''}`;
      });
      const totalLinks = results.reduce((sum, r) => sum + r.crossLinks, 0);
      return { content: [{ type: 'text', text: `Contract sync for group "${name}":\n${lines.join('\n')}\n\nTotal cross-repo links: ${totalLinks}\n\nNext: use group_contracts({name: "${name}"}) to inspect contracts.` }] };
    },
  },

  'astrolabe.group_contracts': {
    name: 'astrolabe.group_contracts',
    description: `Inspect extracted cross-repo contracts for a group. Returns providers, consumers, and cross-links.

Call group_sync first if contracts are stale or not yet extracted.
Returns JSON with providers (method/path/handler), consumers (urlPattern/function/clientType), and crossLinks (matched pairs with confidence scores).`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name from group_list' },
      },
      required: ['name'],
    },
    handler: async (params) => {
      const name = requireString(params, 'name');
      const contracts = getGroupContracts(name);
      if (!contracts) {
        return { content: [{ type: 'text', text: `No contracts extracted for group "${name}". Run group_sync first.` }] };
      }
      const summary = `Group: ${name}\nExtracted: ${new Date(contracts.extractedAt).toISOString()}\nProviders: ${contracts.providers.length}\nConsumers: ${contracts.consumers.length}\nCross-links: ${contracts.crossLinks.length}\n`;
      const nextHint = '\n\nFor full contract data, use context or query tools on specific provider/consumer symbols.';
      return { content: [{ type: 'text', text: summary + JSON.stringify({ crossLinks: contracts.crossLinks.slice(0, 50) }, null, 2) + nextHint }] };
    },
  },

  'astrolabe.route_map': {
    name: 'astrolabe.route_map',
    description: 'Map API route handlers to their consumers. Finds orphaned routes.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repository name from list_repos' } },
      required: [],
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const routes = routeMap(graph);
      if (routes.length === 0) return { content: [{ type: 'text', text: 'No routes detected in the knowledge graph.' }] };
      const lines = routes.map((r) => {
        const icon = r.isOrphaned ? '⚠ orphan' : '  ';
        const consumers = r.consumers.length > 0 ? r.consumers.map((c) => c.name).join(', ') : 'none';
        return `${icon} | ${r.method.toUpperCase().padEnd(7)} ${r.path.padEnd(30)} → ${r.handlerName.padEnd(25)} consumers: ${consumers}`;
      });
      return { content: [{ type: 'text', text: `Route Map (${routes.length} routes):\n${lines.join('\n')}` }] };
    },
  },

  'astrolabe.tool_map': {
    name: 'astrolabe.tool_map',
    description: 'Map MCP/RPC tool definitions to their handlers and callers.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repository name from list_repos' } },
      required: [],
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const tools = toolMap(graph);
      if (tools.length === 0) return { content: [{ type: 'text', text: 'No tools detected in the knowledge graph.' }] };
      const lines = tools.map((t) => {
        const icon = t.isUnused ? '⚠ unused' : '  ';
        const callers = t.callers.length > 0 ? t.callers.map((c) => c.name).join(', ') : 'none';
        return `${icon} | ${t.toolType.padEnd(8)} ${t.toolName.padEnd(25)} → ${t.handlerName.padEnd(25)} callers: ${callers}`;
      });
      return { content: [{ type: 'text', text: `Tool Map (${tools.length} tools):\n${lines.join('\n')}` }] };
    },
  },

  'astrolabe.api_impact': {
    name: 'astrolabe.api_impact',
    description: 'Pre-change impact report for an API route handler or tool.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (function handler, route handler, etc.)' },
        repo: { type: 'string', description: 'Repository name from list_repos' },
      },
      required: ['name'],
    },
    handler: async (params) => {
      const name = requireString(params, 'name');
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const impact = apiImpact(graph, name);
      if (impact.length === 0) return { content: [{ type: 'text', text: `Symbol "${name}" not found.` }] };
      const lines: string[] = [];
      for (const imp of impact) {
        lines.push(`\nImpact for: ${imp.symbol}`);
        if (imp.routes.length > 0) {
          lines.push('Routes:');
          for (const r of imp.routes) {
            lines.push(`  ${r.method.toUpperCase()} ${r.path} — ${r.risk}`);
            if (r.consumers.length > 0) lines.push(`    Consumers: ${r.consumers.join(', ')}`);
          }
        }
        if (imp.tools.length > 0) {
          lines.push('Tools:');
          for (const t of imp.tools) lines.push(`  ${t.type}: ${t.name}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },

  'astrolabe.shape_check': {
    name: 'astrolabe.shape_check',
    description: 'Detect API response shape mismatches between route handlers and consumers.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Route path (e.g., /api/users)' },
        repo: { type: 'string', description: 'Repository name from list_repos' },
      },
      required: ['path'],
    },
    handler: async (params) => {
      const path = requireString(params, 'path');
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const mismatches = shapeCheck(graph, path);
      if (mismatches.length === 0) return { content: [{ type: 'text', text: `No shape mismatches detected for route "${path}".` }] };
      const lines = mismatches.map((m) => `  ${m.severity.toUpperCase()}: ${m.field}`);
      return { content: [{ type: 'text', text: `Shape Check for "${path}" (${mismatches.length} issues):\n${lines.join('\n')}` }] };
    },
  },
};

// ── Resources ──────────────────────────────────────────────────────────────

function getResources() {
  return [
    { uri: 'astrolabe://repos', name: 'All Indexed Repositories', description: 'List all indexed repositories with stats', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/context', name: 'Repo Context', description: 'Codebase overview, stats, staleness check', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/clusters', name: 'Clusters', description: 'All functional clusters with cohesion scores', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/cluster/{clusterName}', name: 'Cluster Detail', description: 'Cluster members and dependency details', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/processes', name: 'Processes', description: 'All execution flows', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/process/{processName}', name: 'Process Trace', description: 'Full process trace with steps', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/schema', name: 'Graph Schema', description: 'Node labels and relationship types', mimeType: 'text/plain' },
  ];
}

function readResource(uri: string): string | null {
  // astrolabe://repos
  if (uri === 'astrolabe://repos') {
    const repos = backend.listRepos();
    return repos.length === 0 ? 'No indexed repositories.' : repos.map((r) => `- ${r.name} (${r.path}) — indexed ${new Date(r.indexedAt).toISOString()}`).join('\n');
  }

  // astrolabe://repo/{name}/context
  const ctxMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/context$/);
  if (ctxMatch) {
    try {
      const ctx = backend.getRepo(ctxMatch[1]);
      const graph = ctx.loadGraph();
      return `Repository: ${ctx.entry.name}\nPath: ${ctx.entry.path}\nNodes: ${graph.nodeCount}\nRelationships: ${graph.relationshipCount}\nLast indexed: ${new Date(ctx.entry.indexedAt).toISOString()}\nLast commit: ${ctx.entry.lastCommit}`;
    } catch { return null; }
  }

  // astrolabe://repo/{name}/clusters
  const clMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/clusters$/);
  if (clMatch) {
    try {
      const ctx = backend.getRepo(clMatch[1]);
      const graph = ctx.loadGraph();
      const clusters: string[] = [];
      for (const node of graph.iterNodes()) {
        if (node.label === 'Community') clusters.push(`- ${node.properties.name ?? node.id} (${node.properties.symbolCount ?? 0} symbols, cohesion: ${node.properties.cohesion ?? 0})`);
      }
      return clusters.length === 0 ? 'No clusters detected.' : clusters.join('\n');
    } catch { return null; }
  }

  // astrolabe://repo/{name}/cluster/{clusterName}
  const ccMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/cluster\/(.+)$/);
  if (ccMatch) {
    try {
      const ctx = backend.getRepo(ccMatch[1]);
      const graph = ctx.loadGraph();
      const clusterName = ccMatch[2];
      const members: string[] = [];
      let cohesion = 0;
      for (const node of graph.iterNodes()) {
        if (node.label !== 'Community') continue;
        if ((node.properties.name === clusterName || node.id.includes(clusterName)) && node.properties.name) {
          cohesion = (node.properties.cohesion as number) ?? 0;
          for (const rel of graph.iterRelationships()) {
            if (rel.type === 'MEMBER_OF' && rel.targetId === node.id) {
              const sym = graph.getNode(rel.sourceId);
              if (sym) members.push(`- ${sym.label.padEnd(12)} ${sym.properties.name ?? '?'} (${sym.properties.filePath ?? '?'})`);
            }
          }
          break;
        }
      }
      if (members.length === 0) return `Cluster "${clusterName}" not found.`;
      return `Cluster: ${clusterName}\nCohesion: ${cohesion}\nMembers:\n${members.join('\n')}`;
    } catch { return null; }
  }

  // astrolabe://repo/{name}/processes
  const prMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/processes$/);
  if (prMatch) {
    try {
      const ctx = backend.getRepo(prMatch[1]);
      const graph = ctx.loadGraph();
      const processes: string[] = [];
      for (const node of graph.iterNodes()) {
        if (node.label === 'Process') processes.push(`- ${node.properties.name ?? node.id} (${node.properties.stepCount ?? 0} steps, type: ${node.properties.processType ?? 'intra'})`);
      }
      return processes.length === 0 ? 'No processes detected.' : processes.join('\n');
    } catch { return null; }
  }

  // astrolabe://repo/{name}/process/{processName}
  const ptMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/process\/(.+)$/);
  if (ptMatch) {
    try {
      const ctx = backend.getRepo(ptMatch[1]);
      const graph = ctx.loadGraph();
      const steps: string[] = [];
      for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
        const proc = graph.getNode(rel.sourceId);
        if (proc && (proc.properties.name === ptMatch[2] || proc.id === ptMatch[2])) {
          const sym = graph.getNode(rel.targetId);
          steps.push(`Step ${rel.step ?? '?'}: ${sym?.properties.name ?? rel.targetId} (${sym?.label ?? '?'} — ${sym?.properties.filePath ?? '?'})`);
        }
      }
      return steps.length === 0 ? 'Process not found.' : steps.sort((a, b) => parseInt(a.match(/Step (\d+)/)?.[1] ?? '0') - parseInt(b.match(/Step (\d+)/)?.[1] ?? '0')).join('\n');
    } catch { return null; }
  }

  // astrolabe://repo/{name}/schema
  const scMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/schema$/);
  if (scMatch) {
    const name = scMatch[1];
    try {
      const ctx = backend.getRepo(name);
      const graph = ctx.loadGraph();
      const labels = new Set<string>();
      const types = new Set<string>();
      for (const node of graph.iterNodes()) labels.add(node.label);
      for (const rel of graph.iterRelationships()) types.add(rel.type);
      return `Node Labels: ${Array.from(labels).sort().join(', ')}\nRelationship Types: ${Array.from(types).sort().join(', ')}`;
    } catch {
      return `Node Labels: File, Folder, Package, Function, Class, Method, Interface, Enum, Variable, Import, Community, Process, Route, Tool, Section, Framework\nRelationship Types: CONTAINS, CALLS, EXTENDS, IMPLEMENTS, IMPORTS, USES, DEFINES, HAS_METHOD, HAS_PROPERTY, MEMBER_OF, STEP_IN_PROCESS, HANDLES_ROUTE, ENTRY_POINT_OF, USES_FRAMEWORK`;
    }
  }

  return null;
}

// ── Prompts ────────────────────────────────────────────────────────────────

function getPrompts() {
  return [
    { name: 'detect_impact', description: 'Pre-commit change analysis — scope, affected processes, risk level' },
    { name: 'generate_map', description: 'Architecture documentation from the knowledge graph' },
  ];
}

function getPromptMessages(name: string, args: Record<string, string>) {
  if (name === 'detect_impact') {
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Analyze the impact of current changes before committing. Steps:
1. Call detect_changes({scope: "${args.scope ?? 'unstaged'}"})
2. For each changed symbol, call context({name: "<symbol>"}) to understand its role
3. Call impact({target: "<symbol>", direction: "upstream"}) for blast radius
4. Summarize: which processes are affected, risk level, whether safe to commit`,
        },
      },
    ];
  }

  if (name === 'generate_map') {
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Generate architecture documentation for this repository:
1. Read astrolabe://repos to discover indexed repos
2. Read astrolabe://repo/{name}/context for overview
3. Read astrolabe://repo/{name}/clusters for functional areas
4. Read astrolabe://repo/{name}/processes for execution flows
5. Create a mermaid architecture diagram showing: modules, key symbols, call chains, data flow
6. Document each cluster's purpose, entry points, and key dependencies`,
        },
      },
    ];
  }

  return null;
}

// ── Server ─────────────────────────────────────────────────────────────────

function isNotification(method: string): boolean {
  return method.startsWith('notifications/');
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: { subscribe: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'astrolabe', version: '0.2.0' },
        },
      };

    case 'resources/list':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: { resources: getResources() },
      };

    case 'resources/read': {
      const rParams = req.params as { uri: string } | undefined;
      const content = readResource(rParams?.uri ?? '');
      if (!content) {
        return { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `Resource not found: ${rParams?.uri}` } };
      }
      return { jsonrpc: '2.0', id: req.id, result: { contents: [{ uri: rParams!.uri, mimeType: 'text/plain', text: content }] } };
    }

    case 'prompts/list':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: { prompts: getPrompts() },
      };

    case 'prompts/get': {
      const pParams = req.params as { name: string; arguments?: Record<string, string> } | undefined;
      const messages = getPromptMessages(pParams?.name ?? '', pParams?.arguments ?? {});
      if (!messages) {
        return { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `Prompt not found: ${pParams?.name}` } };
      }
      return { jsonrpc: '2.0', id: req.id, result: { messages } };
    }

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: Object.values(TOOLS).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case 'tools/call': {
      const params = req.params as { name: string; arguments?: unknown } | undefined;
      const tool = TOOLS[params?.name ?? ''];
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `Unknown tool: ${params?.name}. Available: ${Object.keys(TOOLS).join(', ')}` },
        };
      }
      try {
        const result = await tool.handler((params?.arguments as Record<string, unknown>) ?? {});
        return { jsonrpc: '2.0', id: req.id, result };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32603, message: (err as Error).message },
        };
      }
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return null;

    default:
      if (isNotification(req.method)) return null;
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

export async function startMcpServer(): Promise<void> {
  // #274: Dual-framing transport with security hardening
  const transport = new McpTransport(process.stdin, process.stdout);

  // Graceful shutdown
  process.on('SIGINT', () => { backend.shutdown(); transport.close(); process.exit(0); });
  process.on('SIGTERM', () => { backend.shutdown(); transport.close(); process.exit(0); });

  transport.on('message', async (data: unknown) => {
    try {
      const req = data as JsonRpcRequest;
      const res = await handleRequest(req);
      if (res !== null) {
        transport.send(res);
      }
    } catch {
      // Parse error already handled by transport
    }
  });
}
