/**
 * MCP Backend — LocalBackend class, types, and helper functions.
 *
 * Extracted from server.ts for modularity (#838).
 */

import { execFileSync, fork } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve, join as pathJoin, basename } from 'node:path';
import { createSqliteStore } from '../persist/sqlite.js';
import { createFtsSearch } from '../search/fts.js';
import type { SqliteStore } from '../persist/sqlite.js';
import type { FtsSearch } from '../search/fts.js';
import type { GraphNode } from '../core/types.js';
import { loadRegistry, findEntryWithSiblingWarning, type RegistryEntry } from './registry.js';
import { listGroups } from './groups.js';
import { EDGE_DECAY_FACTORS, applyDecay, noisyOr } from '../analysis/impact-decay.js';
import { JobManager, type AnalyzeJob } from '../server/analyze-job.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface GraphTraversalQuery {
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

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RepoContext {
  store: SqliteStore;
  fts: FtsSearch;
  entry: RegistryEntry;
  /** Database lock — prevents concurrent CLI writes while MCP server is active. */
  lock: { release(): void } | null;
  /** Cached knowledge graph — invalidate with invalidateGraph() on changes (#176). */
  graph?: import('../core/types.js').KnowledgeGraph;
  loadGraph(): import('../core/types.js').KnowledgeGraph;
  invalidateGraph(): void;
}

/** Check if a property bag matches a filter spec. Supports gt/gte/lt/lte operators. */
export function matchesFilter(props: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
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

export function createRepoContext(store: SqliteStore, fts: FtsSearch, entry: RegistryEntry, lock: { release(): void } | null): RepoContext {
  let lastMtime = 0;

  return {
    store,
    fts,
    entry,
    lock,
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

// ── Context boosting helpers ───────────────────────────────────────────────

/** Extract lower-cased key terms from a context/goal string. */
export function extractKeyTerms(text: string): string[] {
  const stopWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'dare',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
    'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
    'they', 'them', 'their', 'what', 'which', 'who', 'whom', 'where',
    'when', 'how', 'not', 'no', 'nor', 'if', 'then', 'else', 'so',
    'as', 'than', 'too', 'very', 'just', 'about', 'above', 'after',
    'before', 'between', 'into', 'through', 'during', 'here', 'there',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
    'some', 'such', 'only', 'own', 'same', 'also', 'find', 'where',
    'looking', 'trying', 'want', 'get', 'show', 'tell', 'know',
  ]);
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !stopWords.has(t));
}

/** Boost FTS results whose name/filePath match context/goal terms. */
export function boostResults<T extends { name: string; filePath: string; score: number }>(
  results: T[],
  taskContext?: string,
  goal?: string,
): void {
  if (!taskContext && !goal) return;
  const contextTerms = extractKeyTerms(`${taskContext ?? ''} ${goal ?? ''}`);
  if (contextTerms.length === 0) return;

  for (const result of results) {
    let boost = 0;
    const nameLower = result.name.toLowerCase();
    const pathLower = result.filePath.toLowerCase();
    for (const term of contextTerms) {
      if (nameLower.includes(term)) boost += 0.1;
      if (pathLower.includes(term)) boost += 0.05;
    }
    result.score *= (1 + Math.min(boost, 0.5)); // cap at 50% boost
  }
  results.sort((a, b) => b.score - a.score);
}

// ── Backend ────────────────────────────────────────────────────────────────

export class LocalBackend {
  private repos = new Map<string, RepoContext>();
  private maxConns = 5;
  private lastAccess = new Map<string, number>();
  private jobManager = new JobManager();

  /**
   * Get the sibling clone warning for a given repo path.
   * Returns a warning message if the path shares the same remote as an indexed repo.
   */
  getSiblingWarning(repoPath: string): string | null {
    const result = findEntryWithSiblingWarning(repoPath);
    return result.siblingWarning;
  }

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
    ctx = createRepoContext(store, fts, entry, null);
    this.repos.set(name, ctx);
    this.lastAccess.set(name, Date.now());
    return ctx;
  }

  listRepos(): RegistryEntry[] {
    return loadRegistry();
  }

  // ── #401: @group Routing ──────────────────────────────────────────────

  /**
   * Resolve `@groupName` or `@groupName/memberPath` to actual repo context(s).
   * Returns { contexts, groupName, memberPath?, servicePath? }.
   */
  resolveGroupRepos(repoParam: string): {
    contexts: Array<{ repo: RepoContext; memberPath: string }>;
    groupName: string;
  } {
    const clean = repoParam.startsWith('@') ? repoParam.substring(1) : repoParam;
    const slashIdx = clean.indexOf('/');
    const groupName = slashIdx >= 0 ? clean.substring(0, slashIdx) : clean;
    const memberPath = slashIdx >= 0 ? clean.substring(slashIdx + 1) : undefined;

    const groups = listGroups();
    const group = groups.find((g) => g.name === groupName);
    if (!group) throw new Error(`Group "${groupName}" not found. Available: ${groups.map((g) => g.name).join(', ')}`);

    const entries = Object.entries(group.repos);
    if (entries.length === 0) throw new Error(`Group "${groupName}" has no repos.`);

    let targetEntries = entries;
    if (memberPath) {
      targetEntries = entries.filter(([path]) => path === memberPath);
      if (targetEntries.length === 0) throw new Error(`Member "${memberPath}" not in group "${groupName}". Available: ${entries.map(([p]) => p).join(', ')}`);
    }

    const contexts: Array<{ repo: RepoContext; memberPath: string }> = [];
    for (const [path, gr] of targetEntries) {
      try {
        const ctx = this.getRepo(gr.repoName);
        contexts.push({ repo: ctx, memberPath: path });
      } catch {
        // skip repos that can't be loaded
      }
    }

    return { contexts, groupName };
  }

  /** #401: Query across group repos with optional service filtering. */
  queryGroup(query: string, repoParam: string, service?: string, limit = 20, taskContext?: string, goal?: string) {
    const { contexts, groupName } = this.resolveGroupRepos(repoParam);
    const allResults: Array<{
      repoName: string;
      definitions: Array<{ name: string; type: string; filePath: string }>;
      processes: Array<Record<string, unknown>>;
      process_symbols: Array<Record<string, unknown>>;
    }> = [];

    for (const { repo, memberPath } of contexts) {
      const result = this.query(query, repo.entry.name, limit, taskContext, goal);

      // #402: Filter by service path if provided
      if (service) {
        const svcPrefix = service.replace(/^\/|\/$/g, '');
        const filteredDefs = result.definitions.filter((d) => d.filePath.startsWith(svcPrefix));
        const filteredSyms = result.process_symbols.filter((s) =>
          (s.filePath as string).startsWith(svcPrefix));
        if (filteredDefs.length === 0 && filteredSyms.length === 0 && result.processes.length === 0) continue;
        allResults.push({
          repoName: `${groupName}/${memberPath}`,
          definitions: filteredDefs,
          processes: result.processes,
          process_symbols: filteredSyms,
        });
      } else {
        const repoName = `${groupName}/${memberPath}`;
        if (result.definitions.length > 0 || result.processes.length > 0) {
          allResults.push({ repoName, ...result });
        }
      }
    }

    return {
      group: groupName,
      service: service || null,
      repos: allResults.length,
      results: allResults,
    };
  }

  /** #401: Context across group repos with optional service filtering. */
  contextGroup(nameOrUid: string, repoParam: string, service?: string, kind?: string, filePath?: string) {
    const { contexts, groupName } = this.resolveGroupRepos(repoParam);
    const allMatches: Array<{ repoName: string; match: Record<string, unknown> }> = [];

    for (const { repo, memberPath } of contexts) {
      const result = this.context(nameOrUid, repo.entry.name, kind, filePath);
      if (!('error' in result)) {
        allMatches.push({ repoName: `${groupName}/${memberPath}`, match: result as unknown as Record<string, unknown> });
      }
    }

    if (allMatches.length === 0) {
      return { error: `Symbol "${nameOrUid}" not found in any repo of group "${groupName}".` };
    }

    return {
      group: groupName,
      service: service || null,
      total_matches: allMatches.reduce((s, m) => s + ((m.match.match_count as number) ?? 0), 0),
      repos: allMatches,
    };
  }


  query(query: string, repo?: string, limit = 20, taskContext?: string, goal?: string) {
    const ctx = this.getRepo(repo);
    const results = ctx.fts.search(query, limit);

    // Check for sibling clone warning
    const siblingWarning = this.getSiblingWarning(ctx.entry.path);

    if (results.length === 0) return { definitions: [], processes: [], process_symbols: [], siblingWarning };

    // Boost results based on task_context and goal keywords
    boostResults(results, taskContext, goal);

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

    return { processes, process_symbols: processSymbols, definitions, siblingWarning };
  }

  context(nameOrUid: string, repo?: string, kind?: string, filePath?: string) {
    const ctx = this.getRepo(repo);
    const graph = ctx.loadGraph();

    // Check for sibling clone warning
    const siblingWarning = this.getSiblingWarning(ctx.entry.path);

    // Find ALL matching symbols (handle overloads) (#116)
    // #764: Compute relevance score for disambiguation
    const symbols: Array<{ node: GraphNode; relevance: number }> = [];
    for (const node of graph.iterNodes()) {
      if (node.id === nameOrUid || node.properties.name === nameOrUid) {
        let relevance: number;
        if (node.id === nameOrUid) {
          relevance = 1.0;
        } else if (kind && node.label === kind) {
          relevance = 0.9;
        } else if (filePath && (node.properties.filePath ?? '').includes(filePath)) {
          relevance = 0.7;
        } else {
          relevance = 0.5;
        }
        // Apply filters if provided
        if (kind && node.label !== kind) continue;
        if (filePath && !(node.properties.filePath ?? '').includes(filePath)) continue;
        symbols.push({ node, relevance });
      }
    }
    if (symbols.length === 0) return { error: `Symbol "${nameOrUid}" not found.`, siblingWarning };

    // Sort by relevance (highest first)
    symbols.sort((a, b) => b.relevance - a.relevance);

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

    // Process index: build once for all symbols (include processType for cross-community visibility)
    const processMap = new Map<string, Array<{ name: string; step: number; total: number; processType: string }>>();
    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      const proc = graph.getNode(rel.sourceId);
      if (!proc) continue;
      let arr = processMap.get(rel.targetId);
      if (!arr) { arr = []; processMap.set(rel.targetId, arr); }
      arr.push({
        name: (proc.properties.name as string) ?? proc.id,
        step: rel.step ?? 0,
        total: (proc.properties.stepCount as number) ?? 0,
        processType: (proc.properties.processType as string) ?? 'intra_community',
      });
    }

    const results = symbols.map((entry) => {
      const inc = incomingMap.get(entry.node.id);
      const incoming: Record<string, string[]> = {};
      if (inc) { for (const [t, names] of inc) incoming[t] = names; }

      const out = outgoingMap.get(entry.node.id);
      const outgoing: Record<string, string[]> = {};
      if (out) { for (const [t, names] of out) outgoing[t] = names; }

      const processes = processMap.get(entry.node.id) ?? [];

      // TODO(#164): Include resolved type information once parser captures
      // returnType/declaredType on Function/Method nodes and cross-file
      // phase produces resolved_returnType.
      const symbolInfo: Record<string, unknown> = {
        uid: entry.node.id,
        kind: entry.node.label,
        name: (entry.node.properties.name as string) ?? '',
        filePath: entry.node.properties.filePath ?? '',
        startLine: entry.node.properties.startLine ?? 0,
      };

      return {
        symbol: symbolInfo,
        incoming,
        outgoing,
        processes,
        relevance: entry.relevance,
      };
    });

    return { match_count: results.length, matches: results, siblingWarning };
  }

  impact(target: string, direction: 'upstream' | 'downstream' = 'upstream', repo?: string, maxDepth = 5, minConfidence = 0.3, timeoutMs = 30_000, targetUid?: string, kind?: string, filePath?: string, mode: 'binary' | 'probabilistic' = 'binary', decaySchedule: 'linear' | 'exponential' | 'logarithmic' = 'linear') {
    const ctx = this.getRepo(repo);
    const graph = ctx.loadGraph();

    // #764: Disambiguation — collect ALL matching candidates instead of first-match break
    const candidates: Array<{ node: GraphNode; relevance: number }> = [];
    for (const node of graph.iterNodes()) {
      let matched = false;
      let relevance = 0;
      if (targetUid && node.id === targetUid) {
        matched = true;
        relevance = 1.0;
      } else if (!targetUid && (node.id === target || node.properties.name === target)) {
        matched = true;
        if (node.id === target) {
          relevance = 1.0;
        } else if (kind && node.label === kind) {
          relevance = 0.9;
        } else if (filePath && (node.properties.filePath ?? '').includes(filePath)) {
          relevance = 0.7;
        } else {
          relevance = 0.5;
        }
      }
      if (!matched) continue;
      // Apply filters
      if (kind && node.label !== kind) continue;
      if (filePath && !(node.properties.filePath ?? '').includes(filePath)) continue;
      candidates.push({ node, relevance });
    }

    if (candidates.length === 0) return { error: `Target "${target}" not found.` };

    // Sort by relevance
    candidates.sort((a, b) => b.relevance - a.relevance);

    // If multiple candidates remain, return disambiguation result instead of picking one
    if (candidates.length > 1) {
      return {
        ambiguous: true as const,
        candidates: candidates.map((c) => ({
          uid: c.node.id,
          name: (c.node.properties.name as string) ?? '',
          kind: c.node.label,
          filePath: c.node.properties.filePath ?? '',
          relevance: c.relevance,
        })),
      };
    }

    const targetNode = candidates[0].node;

    // Pre-build adjacency index: Map<nodeId, { neighborId, type, confidence }[]> (#119)
    // Also track unfiltered edge counts per node for untraceable detection (#695):
    // edges that exist but were filtered by confidence → UNKNOWN risk, not safe.
    const adj = new Map<string, Array<{ neighborId: string; type: string; confidence: number }>>();
    const edgePresence = new Map<string, { upstream: number; downstream: number }>();
    for (const rel of graph.iterRelationships()) {
      // #290: Exclude synthetic STEP_IN_PROCESS edges — being in same process ≠ dependency
      if (rel.type === 'STEP_IN_PROCESS') continue;
      // Track unfiltered edge counts before confidence filter
      const srcP = edgePresence.get(rel.sourceId) ?? { upstream: 0, downstream: 0 };
      const tgtP = edgePresence.get(rel.targetId) ?? { upstream: 0, downstream: 0 };
      srcP.downstream++;
      tgtP.upstream++;
      edgePresence.set(rel.sourceId, srcP);
      edgePresence.set(rel.targetId, tgtP);
      // Confidence filter for actual traversal
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
    const deadline = Date.now() + Math.min(timeoutMs, 3_600_000);

    // #806: Probabilistic mode — track accumulated confidence per node across multiple paths
    const probabilisticResults: Array<{ id: string; name: string; type: string; filePath: string; score: number; paths: Array<{ via: string; depth: number; confidence: number }>; category: string }> = [];
    const nodeScores = new Map<string, { paths: Array<{ via: string; depth: number; confidence: number }>; bestScore: number; bestDepth: number }>();

    // If probabilistic mode, build adj index without confidence filtering
    let probAdj: Map<string, Array<{ neighborId: string; type: string; confidence: number }>> | null = null;
    if (mode === 'probabilistic') {
      probAdj = new Map<string, Array<{ neighborId: string; type: string; confidence: number }>>();
      for (const rel of graph.iterRelationships()) {
        if (rel.type === 'STEP_IN_PROCESS') continue;
        if (direction === 'upstream') {
          let bucket = probAdj.get(rel.targetId);
          if (!bucket) { bucket = []; probAdj.set(rel.targetId, bucket); }
          bucket.push({ neighborId: rel.sourceId, type: rel.type, confidence: rel.confidence });
        } else {
          let bucket = probAdj.get(rel.sourceId);
          if (!bucket) { bucket = []; probAdj.set(rel.sourceId, bucket); }
          bucket.push({ neighborId: rel.targetId, type: rel.type, confidence: rel.confidence });
        }
      }
    }

    while (queue.length > 0 && affected.length < MAX_IMPACT_RESULTS) {
      if (Date.now() >= deadline) { truncated = true; break; }
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const neighbors = mode === 'probabilistic'
        ? (probAdj!.get(current.id) ?? [])
        : (adj.get(current.id) ?? []);

      if (mode === 'probabilistic') {
        // #806: Probabilistic BFS with confidence decay and Noisy-OR fusion
        for (const { neighborId, type, confidence } of neighbors) {
          if (neighborId === targetNode.id) continue;
          if (probabilisticResults.length >= MAX_IMPACT_RESULTS) { truncated = true; break; }

          const edgeDecay = EDGE_DECAY_FACTORS[type] ?? 0.7;
          const parentEntry = nodeScores.get(current.id);
          const parentConfidence = parentEntry?.bestScore ?? 1.0;
          let decayedConfidence = parentConfidence * edgeDecay * Math.max(confidence, 0.1);
          decayedConfidence = applyDecay(decayedConfidence, current.depth + 1, decaySchedule);

          const existing = nodeScores.get(neighborId);
          const pathEntry = { via: current.id, depth: current.depth + 1, confidence: decayedConfidence };

          if (existing) {
            // Noisy-OR: accumulate multi-path evidence
            existing.paths.push(pathEntry);
            const allProbs = existing.paths.map((p) => p.confidence);
            existing.bestScore = noisyOr(allProbs);
            existing.bestDepth = Math.min(existing.bestDepth, current.depth + 1);
          } else {
            nodeScores.set(neighborId, {
              paths: [pathEntry],
              bestScore: decayedConfidence,
              bestDepth: current.depth + 1,
            });
            // Enqueue for further traversal
            if (current.depth + 1 < maxDepth) {
              queue.push({ id: neighborId, depth: current.depth + 1 });
            }
          }
        }
      } else {
        // Binary mode (original)
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
    }

    // #806: Build ranked output for probabilistic mode
    if (mode === 'probabilistic') {
      for (const [id, entry] of nodeScores) {
        const node = graph.getNode(id);
        if (!node) continue;
        probabilisticResults.push({
          id,
          name: (node.properties.name as string) ?? id,
          type: node.label ?? 'unknown',
          filePath: (node.properties.filePath as string) ?? '',
          score: Math.round(entry.bestScore * 1000) / 1000,
          paths: entry.paths.map((p) => ({
            via: p.via,
            depth: p.depth,
            confidence: Math.round(p.confidence * 1000) / 1000,
          })),
          category: '',
        });
      }
      // Sort by score descending
      probabilisticResults.sort((a, b) => b.score - a.score);
      // Categorize by score
      for (const r of probabilisticResults) {
        if (r.score >= 0.8) r.category = 'direct';
        else if (r.score >= 0.4) r.category = 'transitive';
        else r.category = 'low-risk';
      }
      return {
        target: { name: targetNode.properties.name ?? targetNode.id, type: targetNode.label, filePath: targetNode.properties.filePath ?? '' },
        direction,
        mode: 'probabilistic' as const,
        decaySchedule,
        affected_count: probabilisticResults.length,
        truncated,
        results: probabilisticResults.slice(0, 100),
        summary: {
          direct: probabilisticResults.filter((r) => r.category === 'direct').length,
          transitive: probabilisticResults.filter((r) => r.category === 'transitive').length,
          lowRisk: probabilisticResults.filter((r) => r.category === 'low-risk').length,
        },
      };
    }

    // Group by depth with risk levels
    // Cross-community processes get risk boost — they represent cross-cutting concerns
    // with wider blast radius (#153).
    const crossCommunityNodes = new Set<string>();
    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      const proc = graph.getNode(rel.sourceId);
      if (proc?.properties.processType === 'cross_community') {
        crossCommunityNodes.add(rel.targetId);
      }
    }
    // Also include entry points of cross-community processes
    for (const rel of graph.iterRelationshipsByType('ENTRY_POINT_OF')) {
      const proc = graph.getNode(rel.targetId);
      if (proc?.properties.processType === 'cross_community') {
        crossCommunityNodes.add(rel.sourceId);
      }
    }

    const depthGroups: Record<string, { risk: string; items: typeof affected }> = {};
    for (const item of affected) {
      const key = `depth_${item.depth}`;
      if (!depthGroups[key]) {
        depthGroups[key] = { risk: item.depth === 1 ? 'WILL BREAK' : item.depth === 2 ? 'LIKELY AFFECTED' : 'MAYBE AFFECTED', items: [] };
      }
      // Cross-community risk boost: elevate risk for nodes in cross-community processes
      const targetNode = graph.getNode(item.name) ?? [...graph.iterNodes()].find((n) => n.properties.name === item.name);
      if (targetNode && crossCommunityNodes.has(targetNode.id)) {
        if (item.depth === 2) depthGroups[key].risk = 'WILL BREAK';
        else if (item.depth >= 3) depthGroups[key].risk = 'LIKELY AFFECTED';
      }
      depthGroups[key].items.push(item);
    }

    // #643 Pitfall 4: When affected is empty, check if the target had edges
    // that were filtered out (by confidence or direction). If edges exist
    // but couldn't be traced → UNKNOWN risk, not safe.
    // Uses pre-built edgePresence map from adjacency pass (#695): O(1) lookup
    // instead of a second O(E) scan.
    const presence = affected.length === 0 ? edgePresence.get(targetNode.id) : undefined;
    const untraceable = presence
      ? (direction === 'upstream' ? presence.upstream : presence.downstream) > 0
      : false;

    return {
      target: { name: targetNode.properties.name ?? targetNode.id, type: targetNode.label, filePath: targetNode.properties.filePath ?? '' },
      direction,
      affected_count: affected.length,
      truncated, // #248: true if result cap reached
      depth_groups: depthGroups,
      risk: untraceable ? 'UNKNOWN' : undefined,
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
    // Include processType to flag cross-community processes (#153)
    const affectedProcesses: Array<{ name: string; processType: string }> = [];
    const seenProcessNames = new Set<string>();
    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      if (changedNodeIds.has(rel.targetId)) {
        const proc = graph.getNode(rel.sourceId);
        if (proc) {
          const procName = proc.properties.name ?? proc.id;
          if (!seenProcessNames.has(procName)) {
            seenProcessNames.add(procName);
            affectedProcesses.push({
              name: procName,
              processType: (proc.properties.processType as string) ?? 'intra_community',
            });
          }
        }
      }
    }

    const crossCommunityCount = affectedProcesses.filter((p) => p.processType === 'cross_community').length;

    // #643 Pitfall 4: When changed symbols exist but no processes are affected,
    // report UNKNOWN instead of LOW. Symbol tracing may be incomplete.
    const riskLevel = affectedProcesses.length > 3 ? 'high'
      : affectedProcesses.length > 0 ? 'medium'
      : changedNodeIds.size > 0 ? 'unknown'
      : 'low';

    return {
      changed_files: diffFiles,
      changed_count: diffFiles.length,
      affected_count: affectedProcesses.length,
      risk_level: riskLevel,
      changed_symbols: changedSymbols,
      affected_processes: affectedProcesses.map((p) => p.name),
      cross_community_affected: crossCommunityCount,
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

  // ── #944: In-process analysis via MCP ────────────────────────────────

  startAnalysis(repoPath: string): AnalyzeJob {
    const repoName = basename(repoPath);
    const job = this.jobManager.createJob({ repoPath, repoName });

    if (job.status !== 'queued') return job;

    this.jobManager.updateJob(job.id, {
      status: 'analyzing',
      progress: { phase: 'analyzing', percent: 0, message: 'Starting analysis...' },
    });

    const __filename = fileURLToPath(import.meta.url);
    const cliDistPath = pathResolve(__filename, '..', '..', '..', 'cli', 'dist', 'index.js');
    const workerPath = existsSync(cliDistPath) ? cliDistPath : process.argv[1] ?? cliDistPath;

    const args = ['analyze', repoPath, '-o', pathJoin(repoPath, '.astrolabe', 'astrolabe.db')];
    const child = fork(workerPath, args, { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });

    this.jobManager.registerChild(job.id, child);

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8');
      const phaseMatch = text.match(/(\w+)\s+(phase|complete)/i);
      if (phaseMatch) {
        this.jobManager.updateJob(job.id, {
          progress: { phase: phaseMatch[1].toLowerCase(), percent: 50, message: text.trim().slice(0, 200) },
        });
      }
    });

    child.on('message', (msg: unknown) => {
      const m = msg as { type?: string; phase?: string; percent?: number; message?: string };
      if (m && m.type === 'progress' && m.phase !== undefined && m.percent !== undefined) {
        this.jobManager.updateJob(job.id, {
          progress: { phase: m.phase, percent: m.percent, message: m.message ?? '' },
        });
      }
    });

    child.on('exit', (code: number | null) => {
      if (code === 0) {
        this.jobManager.updateJob(job.id, {
          status: 'complete',
          progress: { phase: 'complete', percent: 100, message: 'Analysis complete' },
        });
      } else {
        this.jobManager.updateJob(job.id, {
          status: 'failed',
          error: `Analysis exited with code ${code}`,
        });
      }
    });

    child.on('error', (err: Error) => {
      this.jobManager.updateJob(job.id, { status: 'failed', error: err.message });
    });

    return job;
  }

  getJob(jobId: string): AnalyzeJob | undefined {
    return this.jobManager.getJob(jobId);
  }

  cancelAnalysis(jobId: string): boolean {
    return this.jobManager.cancelJob(jobId);
  }

  shutdown(): void {
    this.jobManager.dispose();
    for (const ctx of this.repos.values()) {
      ctx.store.close();
      ctx.fts.close();
    }
    // #301: Also clear lastAccess to prevent stale entry divergence
    this.repos.clear();
    this.lastAccess.clear();
  }
}
