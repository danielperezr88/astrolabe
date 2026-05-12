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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { createSqliteStore } from '../persist/sqlite.js';
import { createFtsSearch } from '../search/fts.js';
import type { SqliteStore } from '../persist/sqlite.js';
import type { FtsSearch } from '../search/fts.js';
import type { GraphNode } from '../core/types.js';
import { loadRegistry, findEntryWithSiblingWarning, type RegistryEntry } from './registry.js';
import { listGroups, getGroupStatus, groupQuery } from './groups.js';
import { syncGroupContracts, getGroupContracts } from './contracts.js';
import { McpTransport } from './transport.js';
import { StreamableHttpTransport } from './http-transport.js';
import { routeMap, toolMap, apiImpact, shapeCheck } from './api-tools.js';
import { executeTraversal, type TraversalQuery } from './traverse.js';
import { PhaseTimer } from '../core/phase-timer.js';
import { pageRank, betweennessCentrality, shortestPath } from '../core/graph-algorithms.js';
import { chat as ragChat, type ChatMessage } from '../agent/rag-chat.js';
import { generateDiagram, generateMarkdownDoc, type DiagramType, type DiagramOptions } from './diagram-generator.js';
// #461: Graphlet-based structural analysis
import { countGraphlets, buildAdjacencyMap, detectPatterns, scoreArchitectureHealth } from '../analysis/graphlet/index.js';
import type { CommunityInfo } from '../analysis/graphlet/index.js';
import { EDGE_DECAY_FACTORS, applyDecay, noisyOr } from '../analysis/impact-decay.js';

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
  /** Database lock — prevents concurrent CLI writes while MCP server is active. */
  lock: { release(): void } | null;
  /** Cached knowledge graph — invalidate with invalidateGraph() on changes (#176). */
  graph?: import('../core/types.js').KnowledgeGraph;
  loadGraph(): import('../core/types.js').KnowledgeGraph;
  invalidateGraph(): void;
}

function createRepoContext(store: SqliteStore, fts: FtsSearch, entry: RegistryEntry, lock: { release(): void } | null): RepoContext {
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
function extractKeyTerms(text: string): string[] {
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
function boostResults<T extends { name: string; filePath: string; score: number }>(
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

class LocalBackend {
  private repos = new Map<string, RepoContext>();
  private maxConns = 5;
  private lastAccess = new Map<string, number>();

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
    description: `Hybrid search over the knowledge graph. Returns process-grouped results for architectural context.

GROUP MODE: set "repo" to "@<groupName>" to search all member repos in that group, or "@<groupName>/<memberPath>" to scope to one member. Use "service" for monorepo subdirectory filtering.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (symbol name, concept, etc.)' },
        limit: { type: 'number', description: 'Max results', default: 20 },
        repo: { type: 'string', description: 'Repository name, or "@<groupName>" / "@<groupName>/<memberPath>" for group mode. Omit if only one repo indexed.' },
        service: { type: 'string', description: 'Optional monorepo path prefix filter (only active in group mode)' },
        task_context: { type: 'string', description: 'Context about the current task (e.g., "debugging auth flow")' },
        goal: { type: 'string', description: 'What the search aims to find (e.g., "find where tokens are validated")' },
      },
      required: ['query'],
    },
    handler: async (params) => {
      const timer = new PhaseTimer('query');
      timer.start();
      const query = requireString(params, 'query');
      const repo = params.repo as string | undefined;
      const service = params.service as string | undefined;
      const taskContext = params.task_context as string | undefined;
      const goal = params.goal as string | undefined;
      let result: unknown;

      if (repo?.startsWith('@')) {
        result = backend.queryGroup(query, repo, service, requireNumber(params, 'limit', 20), taskContext, goal);
      } else {
        result = backend.query(query, repo, requireNumber(params, 'limit', 20), taskContext, goal);
      }

      timer.mark('search');
      const nextHint = '\n\nNext: use context({name: "foundSymbol"}) to get 360-degree view of any result.';
      timer.mark('format');
      timer.stop();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.context': {
    name: 'astrolabe.context',
    description: `360-degree symbol view — callers, callees, process membership for one symbol.

GROUP MODE: set "repo" to "@<groupName>" to search all member repos, or "@<groupName>/<memberPath>" for one member.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name or node ID' },
        repo: { type: 'string', description: 'Repository name, or "@<groupName>" / "@<groupName>/<memberPath>" for group mode' },
        service: { type: 'string', description: 'Optional monorepo path prefix filter (only active in group mode)' },
        kind: { type: 'string', description: 'Node label filter (Function, Class, Method, etc.) for disambiguation' },
        file_path: { type: 'string', description: 'File path filter (substring match) for disambiguation' },
      },
      required: ['name'],
    },
    handler: async (params) => {
      const timer = new PhaseTimer('context');
      timer.start();
      const name = requireString(params, 'name');
      const repo = params.repo as string | undefined;
      const service = params.service as string | undefined;
      const kind = params.kind as string | undefined;
      const filePath = params.file_path as string | undefined;
      let result: unknown;

      if (repo?.startsWith('@')) {
        result = backend.contextGroup(name, repo, service, kind, filePath);
      } else {
        result = backend.context(name, repo, kind, filePath);
      }

      timer.mark('lookup');
      const nextHint = '\n\nNext: use impact({target: "symbolName", direction: "upstream"}) for blast radius analysis.';
      timer.mark('format');
      timer.stop();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.impact': {
    name: 'astrolabe.impact',
    description: `Blast radius analysis — what depends on this symbol, grouped by depth with risk levels.

GROUP MODE: set "repo" to "@<groupName>" to anchor impact in a group member and fan out across repos.
crossDepth: cross-repo hop depth via contract bridge (default 0 = single repo, 1+ = fan out).
subgroup: limit cross-repo fan-out to specific member repos.
service: monorepo path prefix filter (only active in group mode).`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Symbol name or node ID to analyze' },
        direction: { type: 'string', enum: ['upstream', 'downstream'], default: 'upstream' },
        maxDepth: { type: 'number', description: 'How many levels to traverse in local graph', default: 5 },
        minConfidence: { type: 'number', description: 'Minimum edge confidence (0.0-1.0)', default: 0.3 },
        crossDepth: { type: 'number', description: 'Cross-repo hop depth via contract bridge (0 = single repo only)', default: 0 },
        timeoutMs: { type: 'number', description: 'Wall-clock budget in ms (default 30000, max 3600000). Returns partial results if exceeded.', default: 30000 },
        repo: { type: 'string', description: 'Repository name, or "@<groupName>" / "@<groupName>/<memberPath>" for group mode' },
        service: { type: 'string', description: 'Optional monorepo path prefix filter (only active in group mode)' },
        subgroup: { type: 'string', description: 'Optional group subgroup prefix limiting cross-repo fan-out' },
        targetUid: { type: 'string', description: 'Exact node ID for zero-ambiguity lookup (skips name resolution)' },
        kind: { type: 'string', description: 'Node label filter for disambiguation when target name is ambiguous' },
        file_path: { type: 'string', description: 'File path filter for disambiguation' },
        mode: { type: 'string', description: 'Impact scoring mode: binary (current) or probabilistic (confidence decay with Noisy-OR fusion)', enum: ['binary', 'probabilistic'] },
        decaySchedule: { type: 'string', description: 'Decay schedule for probabilistic mode (default: linear)', enum: ['linear', 'exponential', 'logarithmic'] },
      },
      required: ['target', 'direction'],
    },
    handler: async (params) => {
      const timer = new PhaseTimer('impact');
      timer.start();
      const target = requireString(params, 'target');
      const repo = params.repo as string | undefined;
      const crossDepth = requireNumber(params, 'crossDepth', 0);
      const timeoutMs = Math.min(requireNumber(params, 'timeoutMs', 30000), 3_600_000);
      const targetUid = params.targetUid as string | undefined;
      const kind = params.kind as string | undefined;
      const filePath = params.file_path as string | undefined;
      const mode = (params.mode as string) ?? 'binary';
      const decaySchedule = (params.decaySchedule as string) ?? 'linear';
      let result: unknown;

      if (repo?.startsWith('@') && crossDepth > 0) {
        // #400: Cross-repo impact with boundary fan-out
        const { contexts, groupName } = backend.resolveGroupRepos(repo);
        // Anchor in first available context
        const anchor = contexts[0];
        if (!anchor) return { content: [{ type: 'text', text: JSON.stringify({ error: `No repos found in group "${groupName}"` }) }] };

        const localResult = backend.impact(
          target,
          (params.direction as 'upstream' | 'downstream') ?? 'upstream',
          anchor.repo.entry.name,
          requireNumber(params, 'maxDepth', 5),
          requireNumber(params, 'minConfidence', 0.3),
          timeoutMs,
          targetUid,
          kind,
          filePath,
          mode as 'binary' | 'probabilistic',
          decaySchedule as 'linear' | 'exponential' | 'logarithmic',
        );

        // Cross-repo fan-out via contract links
        const crossResults: unknown[] = [];
        if (crossDepth > 0 && contexts.length > 1) {
          const groupName = repo.startsWith('@') ? repo.substring(1).split('/')[0] : '';
          const subgroup = params.subgroup as string | undefined;
          try {
            const contracts = getGroupContracts(groupName);
            if (contracts) {
              const affectedSymbols = new Set<string>();
              if (!('error' in localResult)) {
                for (const dg of Object.values((localResult as any).depth_groups ?? {})) {
                  for (const item of (dg as any).items ?? []) {
                    affectedSymbols.add(item.name);
                  }
                }
              }

              for (const link of contracts.crossLinks) {
                // #409: Check if any affected symbol matches the provider's handler function name
                const linkConsumed = (link.provider.handlerName && affectedSymbols.has(link.provider.handlerName))
                  || affectedSymbols.has(link.consumer.functionName);
                if (!linkConsumed) continue;

                const targetRepo = link.consumer.repoName;
                if (subgroup && !targetRepo.includes(subgroup)) continue;

                try {
                  const crossResult = backend.impact(
                    link.consumer.functionName,
                    'downstream',
                    targetRepo,
                    requireNumber(params, 'maxDepth', 3),
                    requireNumber(params, 'minConfidence', 0.3),
                    timeoutMs,
                    undefined,
                    undefined,
                    undefined,
                    mode as 'binary' | 'probabilistic',
                    decaySchedule as 'linear' | 'exponential' | 'logarithmic',
                  );
                  crossResults.push({ repo: targetRepo, contract: link.contractType, link, result: crossResult });
                } catch { /* skip unreachable repos */ }
              }
            }
          } catch { /* group not found or no contracts */ }
        }

        result = {
          group: groupName,
          anchor: anchor.repo.entry.name,
          local_impact: localResult,
          cross_repo: crossResults.length > 0 ? crossResults : undefined,
          cross_depth: crossDepth,
        };
      } else if (repo?.startsWith('@')) {
        // Group mode without cross-depth — just anchor
        const { contexts } = backend.resolveGroupRepos(repo);
        const anchor = contexts[0];
        result = backend.impact(
          target,
          (params.direction as 'upstream' | 'downstream') ?? 'upstream',
          anchor?.repo.entry.name,
          requireNumber(params, 'maxDepth', 5),
          requireNumber(params, 'minConfidence', 0.3),
          timeoutMs,
          targetUid,
          kind,
          filePath,
          mode as 'binary' | 'probabilistic',
          decaySchedule as 'linear' | 'exponential' | 'logarithmic',
        );
      } else {
        result = backend.impact(
          target,
          (params.direction as 'upstream' | 'downstream') ?? 'upstream',
          repo,
          requireNumber(params, 'maxDepth', 5),
          requireNumber(params, 'minConfidence', 0.3),
          timeoutMs,
          targetUid,
          kind,
          filePath,
          mode as 'binary' | 'probabilistic',
          decaySchedule as 'linear' | 'exponential' | 'logarithmic',
        );
      }

      timer.mark('traverse');
      const nextHint = '\n\nNext: use detect_changes() before committing to verify your changes match expected impact.';
      timer.mark('format');
      timer.stop();
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
      const timer = new PhaseTimer('detect_changes');
      timer.start();
      const result = backend.detectChanges((params.scope as 'unstaged' | 'staged' | 'all') ?? 'unstaged', params.repo as string);
      timer.mark('diff');
      timer.stop();
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
      const sharedLibCount = (contracts as any).sharedLibs?.length ?? 0;
      const summary = `Group: ${name}\nExtracted: ${new Date(contracts.extractedAt).toISOString()}\nProviders: ${contracts.providers.length}\nConsumers: ${contracts.consumers.length}\nCross-links: ${contracts.crossLinks.length}${sharedLibCount > 0 ? `\nShared libraries: ${sharedLibCount}` : ''}\n`;
      const nextHint = '\n\nFor full contract data, use context or query tools on specific provider/consumer symbols.';
      const payload: Record<string, unknown> = { crossLinks: contracts.crossLinks.slice(0, 50) };
      if (sharedLibCount > 0) payload.sharedLibs = (contracts as any).sharedLibs.slice(0, 20);
      return { content: [{ type: 'text', text: summary + JSON.stringify(payload, null, 2) + nextHint }] };
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
      const impact = await apiImpact(graph, name, ctx.entry.path);
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
        if (imp.shapeDrift.length > 0) {
          lines.push('Shape Drift:');
          for (const sd of imp.shapeDrift) lines.push(`  ${sd.severity}: ${sd.field}`);
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
      const mismatches = await shapeCheck(graph, path, ctx.entry.path);
      if (mismatches.length === 0) return { content: [{ type: 'text', text: `No shape mismatches detected for route "${path}".` }] };
      const lines = mismatches.map((m) => `  ${m.severity.toUpperCase()}: ${m.field} — ${m.reason}`);
      return { content: [{ type: 'text', text: `Shape Check for "${path}" (${mismatches.length} issues):\n${lines.join('\n')}` }] };
    },
  },

  'astrolabe.group_impact': {
    name: 'astrolabe.group_impact',
    description: `Cross-repo impact analysis within a group. Resolves target symbol across all group members, runs local impact, then fans out via contract bridges (HTTP, gRPC, topic contracts).

Returns direct impacts (within same repo) plus cross-repo impacts discovered through contract links, with an overall risk assessment.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        target: { type: 'string', description: 'Target symbol to analyze' },
        direction: { type: 'string', enum: ['upstream', 'downstream', 'both'], default: 'both' },
        maxDepth: { type: 'number', default: 3 },
        crossDepth: { type: 'number', default: 2 },
        minConfidence: { type: 'number', default: 0.3 },
        targetUid: { type: 'string', description: 'Exact node ID for zero-ambiguity lookup (skips name resolution)' },
        kind: { type: 'string', description: 'Node label filter for disambiguation when target name is ambiguous' },
        file_path: { type: 'string', description: 'File path filter for disambiguation' },
      },
      required: ['name', 'target'],
    },
    handler: async (params) => {
      const timer = new PhaseTimer('group_impact');
      timer.start();
      const groupName = requireString(params, 'name');
      const target = requireString(params, 'target');
      const direction = (params.direction as 'upstream' | 'downstream' | 'both') ?? 'both';
      const maxDepth = requireNumber(params, 'maxDepth', 3);
      const crossDepth = requireNumber(params, 'crossDepth', 2);
      const minConfidence = requireNumber(params, 'minConfidence', 0.3);
      const targetUid = params.targetUid as string | undefined;
      const kind = params.kind as string | undefined;
      const filePath = params.file_path as string | undefined;

      // 1. Resolve the group
      const groups = listGroups();
      const group = groups.find((g) => g.name === groupName);
      if (!group) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Group '${groupName}' not found` }) }] };
      }

      // 2. Load reachable contexts for all group members
      let contexts: Array<{ repo: RepoContext; memberPath: string }>;
      try {
        ({ contexts } = backend.resolveGroupRepos(`@${groupName}`));
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `No reachable repos in group '${groupName}'` }) }] };
      }
      if (contexts.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `No reachable repos in group '${groupName}'` }) }] };
      }

      // 3. Search for target across all group members (#764: collect all matches, not first-match break)
      let anchorRepo: string | undefined;
      const reposWithTarget: string[] = [];
      for (const { repo } of contexts) {
        const graph = repo.loadGraph();
        const repoCandidates: Array<{ uid: string; name: string; kind: string; filePath: string; relevance: number }> = [];
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
          if (kind && node.label !== kind) continue;
          if (filePath && !(node.properties.filePath ?? '').includes(filePath)) continue;
          repoCandidates.push({
            uid: node.id,
            name: (node.properties.name as string) ?? '',
            kind: node.label,
            filePath: node.properties.filePath ?? '',
            relevance,
          });
        }
        if (repoCandidates.length > 0) {
          if (!anchorRepo) anchorRepo = repo.entry.name;
          if (!reposWithTarget.includes(repo.entry.name)) {
            reposWithTarget.push(repo.entry.name);
          }
        }
      }

      if (!anchorRepo) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Target '${target}' not found in group '${groupName}'` }) }] };
      }

      timer.mark('resolve');

      // 4. Run impact within anchor repo (call once per direction)
      const directions: Array<'upstream' | 'downstream'> = direction === 'both'
        ? ['upstream', 'downstream']
        : [direction];

      const directResults: Record<string, ReturnType<LocalBackend['impact']>> = {};
      const affectedSymbols = new Set<string>();

      for (const dir of directions) {
        const result = backend.impact(target, dir, anchorRepo, maxDepth, minConfidence);
        directResults[dir] = result;
        // Collect affected symbol names for contract fan-out
        if (result && typeof result === 'object' && 'depth_groups' in result) {
          const dg = (result as { depth_groups: Record<string, { items: Array<{ name: string }> }> }).depth_groups;
          for (const group of Object.values(dg)) {
            for (const item of group.items) {
              affectedSymbols.add(item.name);
            }
          }
        }
      }

      timer.mark('direct_impact');

      // 5. Fan out via contracts
      const crossRepoImpacts: Array<Record<string, unknown>> = [];
      if (crossDepth > 0) {
        try {
          const contracts = getGroupContracts(groupName);
          if (contracts) {
            for (const link of contracts.crossLinks) {
              const linkConsumed = (link.provider.handlerName !== undefined && affectedSymbols.has(link.provider.handlerName))
                || affectedSymbols.has(link.consumer.functionName);
              if (!linkConsumed) continue;

              // Skip same-repo (already covered by direct analysis)
              if (link.consumer.repoName === anchorRepo && link.provider.repoName === anchorRepo) continue;

              const isProviderAffected = affectedSymbols.has(link.provider.handlerName ?? '');
              const targetRepo = isProviderAffected ? link.consumer.repoName : link.provider.repoName;
              const targetSymbol = isProviderAffected ? link.consumer.functionName : (link.provider.handlerName ?? link.provider.path);

              try {
                const crossResult = backend.impact(
                  targetSymbol,
                  'downstream',
                  targetRepo,
                  Math.min(maxDepth, crossDepth),
                  minConfidence,
                );
                crossRepoImpacts.push({
                  repo: targetRepo,
                  contractType: link.contractType,
                  confidence: link.confidence,
                  bridge: `${link.provider.repoName} → ${link.consumer.repoName} (${link.contractType})`,
                  result: crossResult,
                });
              } catch {
                // skip unreachable repos
              }
            }
          }
        } catch {
          // group contracts not available — skip cross-repo fan-out
        }
      }

      timer.mark('cross_repo');

      // 6. Risk assessment
      let directCount = 0;
      for (const result of Object.values(directResults)) {
        if (result && typeof result === 'object' && 'affected_count' in result) {
          directCount += (result as { affected_count: number }).affected_count;
        }
      }

      const crossCount = crossRepoImpacts.length;
      const riskLevel = directCount > 10 || crossCount > 3 ? 'critical'
        : directCount > 5 || crossCount > 1 ? 'high'
        : directCount > 0 || crossCount > 0 ? 'medium'
        : 'low';

      const output = {
        group: groupName,
        target,
        anchorRepo,
        reposWithTarget,
        directImpacts: direction === 'both' ? directResults : directResults[direction],
        crossRepoImpacts: crossRepoImpacts.length > 0 ? crossRepoImpacts : undefined,
        riskAssessment: {
          level: riskLevel,
          directAffectedCount: directCount,
          crossRepoBridges: crossCount,
          breakdown: {
            willBreak: directCount > 0 ? 'direct dependents at depth 1' : 'none',
            crossRepo: crossCount > 0 ? `${crossCount} cross-repo contract bridge(s) affected` : 'none',
          },
        },
      };

      timer.mark('format');
      timer.stop();
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  },

  'astrolabe.graph_algorithms': {
    name: 'astrolabe.graph_algorithms',
    description: `Run graph algorithms on the knowledge graph for architecture analysis.

Algorithms:
- pagerank: Identify the most important modules by link structure. Returns nodes sorted by PageRank score.
- betweenness: Find bridge nodes that connect different communities. High betweenness = critical dependency bottleneck.
- shortest_path: Find the dependency chain between two modules. Returns the shortest path or null.

The graph is built from CALLS and IMPORTS relationships (excluding STEP_IN_PROCESS synthetic edges).`,
    inputSchema: {
      type: 'object',
      properties: {
        algorithm: { type: 'string', enum: ['pagerank', 'betweenness', 'shortest_path'], description: 'Algorithm to run' },
        source: { type: 'string', description: 'Source node ID or name (required for shortest_path)' },
        target: { type: 'string', description: 'Target node ID or name (required for shortest_path)' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['algorithm'],
    },
    handler: async (params) => {
      const algorithm = requireString(params, 'algorithm');
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();

      // Build adjacency list from CALLS and IMPORTS edges
      const adjList = new Map<string, string[]>();
      const allNodes = new Set<string>();

      // Ensure all nodes are in the adjacency list
      for (const node of graph.iterNodes()) {
        allNodes.add(node.id);
        if (!adjList.has(node.id)) adjList.set(node.id, []);
      }

      for (const rel of graph.iterRelationships()) {
        if (rel.type === 'STEP_IN_PROCESS' || rel.type === 'MEMBER_OF' || rel.type === 'ENTRY_POINT_OF') continue;
        if (rel.type !== 'CALLS' && rel.type !== 'IMPORTS') continue;

        let targets = adjList.get(rel.sourceId);
        if (!targets) { targets = []; adjList.set(rel.sourceId, targets); }
        targets.push(rel.targetId);

        // Ensure target node has an entry too
        if (!adjList.has(rel.targetId)) adjList.set(rel.targetId, []);
      }

      if (algorithm === 'pagerank') {
        const results = pageRank(adjList);
        // Resolve node names for readability
        const named = results.slice(0, 50).map((r) => {
          const node = graph.getNode(r.nodeId);
          return {
            id: r.nodeId,
            name: node?.properties.name ?? r.nodeId,
            score: Math.round(r.score * 10000) / 10000,
          };
        });
        return { content: [{ type: 'text', text: JSON.stringify({ algorithm: 'pagerank', nodeCount: results.length, topNodes: named }, null, 2) }] };
      }

      if (algorithm === 'betweenness') {
        const results = betweennessCentrality(adjList);
        const named = results.slice(0, 50).map((r) => {
          const node = graph.getNode(r.nodeId);
          return {
            id: r.nodeId,
            name: node?.properties.name ?? r.nodeId,
            score: Math.round(r.score * 10000) / 10000,
          };
        });
        return { content: [{ type: 'text', text: JSON.stringify({ algorithm: 'betweenness', nodeCount: results.length, topNodes: named }, null, 2) }] };
      }

      if (algorithm === 'shortest_path') {
        const sourceParam = requireString(params, 'source');
        const targetParam = requireString(params, 'target');

        // Resolve source/target names to IDs
        let sourceId = sourceParam;
        let targetId = targetParam;
        for (const node of graph.iterNodes()) {
          if (node.properties.name === sourceParam || node.id === sourceParam) sourceId = node.id;
          if (node.properties.name === targetParam || node.id === targetParam) targetId = node.id;
        }

        const path = shortestPath(adjList, sourceId, targetId);

        if (!path) {
          return { content: [{ type: 'text', text: JSON.stringify({ algorithm: 'shortest_path', source: sourceParam, target: targetParam, path: null, message: 'No path found between the specified nodes.' }) }] };
        }

        const namedPath = path.map((id) => {
          const node = graph.getNode(id);
          return node?.properties.name ?? id;
        });

        return { content: [{ type: 'text', text: JSON.stringify({ algorithm: 'shortest_path', source: sourceParam, target: targetParam, path: namedPath, length: path.length - 1 }, null, 2) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown algorithm: ${algorithm}` }) }] };
    },
  },

  'astrolabe.grep': {
    name: 'astrolabe.grep',
    description: `Regex search across file contents in the indexed repository. Returns matching lines with file path and line number.

ReDoS protection: pattern max 200 chars. Results capped at 50 by default (max 200).`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for (max 200 chars)' },
        repo: { type: 'string', description: 'Repository name' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)', default: 50 },
      },
      required: ['pattern'],
    },
    handler: async (params) => {
      const pattern = requireString(params, 'pattern');
      if (pattern.length > 200) throw new Error('Pattern too long (max 200 characters)');

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'gim');
      } catch {
        throw new Error('Invalid regex pattern');
      }

      const limit = Math.max(1, Math.min(200, requireNumber(params, 'limit', 50)));
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const repoRoot = ctx.entry.path;
      const results: Array<{ filePath: string; line: number; text: string }> = [];

      // Collect indexed file paths from graph
      const indexedFiles = new Set<string>();
      for (const node of graph.iterNodes()) {
        if (node.label === 'File' && node.properties.filePath) {
          indexedFiles.add(node.properties.filePath as string);
        }
      }

      // Search files on disk one at a time (constant memory)
      for (const filePath of indexedFiles) {
        if (results.length >= limit) break;
        const fullPath = pathJoin(repoRoot, filePath);

        // Path traversal guard
        if (!fullPath.startsWith(repoRoot)) continue;
        if (!existsSync(fullPath)) continue;

        let content: string;
        try {
          content = readFileSync(fullPath, 'utf-8');
        } catch {
          continue; // File may have been deleted since indexing
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= limit) break;
          if (regex.test(lines[i])) {
            results.push({ filePath, line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
          regex.lastIndex = 0;
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ matches: results.length, results }, null, 2) }] };
    },
  },

  'astrolabe.chat': {
    name: 'astrolabe.chat',
    description: `Conversational AI assistant grounded in the knowledge graph. Ask questions about the codebase in natural language.

Uses RAG (Retrieval-Augmented Generation): retrieves relevant symbols from the graph, then generates a grounded answer via an OpenAI-compatible LLM.

Requires ASTROLABE_API_KEY or OPENAI_API_KEY environment variable to be set for the MCP server process.`,
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Your question about the codebase' },
        repo: { type: 'string', description: 'Repository name (omit if only one indexed)' },
        history: { type: 'array', description: 'Previous conversation messages [{role: "user"|"assistant", content: "..."}]', items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } }, required: ['role', 'content'] } },
      },
      required: ['message'],
    },
    handler: async (params) => {
      const message = requireString(params, 'message');
      const repo = params.repo as string | undefined;
      const history = (params.history as Array<{ role: string; content: string }>) ?? [];

      // Build conversation messages
      const messages: ChatMessage[] = history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      messages.push({ role: 'user', content: message });

      try {
        const result = await ragChat(messages, { repo });
        const sourceLines = result.sources.length > 0
          ? '\n\nSources:\n' + result.sources.slice(0, 10).map((s, i) => `${i + 1}. ${s.name} (${s.type}) — ${s.filePath}`).join('\n')
          : '';
        return { content: [{ type: 'text', text: result.content + sourceLines }] };
      } catch (err: any) {
        if (err.message?.includes('No API key')) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
        throw err;
      }
    },
  },

  'astrolabe.generate_diagram': {
    name: 'astrolabe.generate_diagram',
    description: `Generate Mermaid architecture diagrams from the knowledge graph.

DIAGRAM TYPES:
- community: Cluster subgraphs showing module boundaries, member symbols, and coupling edges
- process: Execution flow diagrams from entry points through step-by-step call traces
- dependency: Directed graph of CALLS, IMPORTS, EXTENDS, IMPLEMENTS, USES relationships
- class_hierarchy: Inheritance tree showing EXTENDS/IMPLEMENTS between classes and interfaces`,
    inputSchema: {
      type: 'object',
      properties: {
        diagram_type: { type: 'string', enum: ['community', 'process', 'dependency', 'class_hierarchy'], description: 'Type of diagram to generate' },
        repo: { type: 'string', description: 'Repository name' },
        cluster_id: { type: 'string', description: 'Filter community diagram to a specific cluster (by id or name)' },
        process_id: { type: 'string', description: 'Filter process diagram to a specific process (by id or name)' },
        format: { type: 'string', enum: ['mermaid', 'markdown'], description: 'Output format. "mermaid" returns raw diagram code. "markdown" wraps in documentation.', default: 'mermaid' },
        max_nodes: { type: 'number', description: 'Maximum nodes to include (default: 200 for community, 100 for others)' },
        min_confidence: { type: 'number', description: 'Minimum edge confidence threshold (default: 0.5)' },
      },
      required: ['diagram_type'],
    },
    handler: async (params) => {
      const diagramType = requireString(params, 'diagram_type') as DiagramType;
      const format = (params.format as string) ?? 'mermaid';
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();

      const opts: DiagramOptions = {
        type: diagramType,
        clusterId: params.cluster_id as string | undefined,
        processId: params.process_id as string | undefined,
        maxNodes: params.max_nodes as number | undefined,
        minConfidence: params.min_confidence as number | undefined,
      };

      if (format === 'markdown') {
        const repoName = (params.repo as string) ?? ctx.entry.name;
        const doc = generateMarkdownDoc(graph, opts, repoName);
        return { content: [{ type: 'text', text: doc }] };
      }

      const result = generateDiagram(graph, opts);
      const statsLine = `// ${result.stats.nodeCount} nodes, ${result.stats.edgeCount} edges`;
      return { content: [{ type: 'text', text: result.diagram + '\n\n' + statsLine }] };
    },
  },

  'astrolabe.analyze_architecture': {
    name: 'astrolabe.analyze_architecture',
    description: `Analyze architectural patterns using graphlet-based structural analysis. Detects hub-and-spoke, chain, diamond, and cycle motifs. Maps to architectural patterns (layered, microservices, event-driven, MVC) and scores overall health.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        include_health: { type: 'boolean', description: 'Include architecture health scoring (default: true)' },
      },
    },
    handler: async (params) => {
      const timer = new PhaseTimer('analyze_architecture');
      timer.start();

      // 1. Load graph
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();

      // 2. Collect non-structural node IDs (exclude File, Folder, Import, Package)
      const structuralLabels = new Set(['File', 'Folder', 'Import', 'Package']);
      const nodeIds = new Set<string>();
      const nodeIterable: Array<{ id: string }> = [];
      for (const node of graph.iterNodes()) {
        if (!structuralLabels.has(node.label)) {
          nodeIds.add(node.id);
          nodeIterable.push({ id: node.id });
        }
      }

      // 3. Build adjacency map from CALLS, IMPORTS, EXTENDS edges only
      const allowedEdgeTypes = new Set(['CALLS', 'IMPORTS', 'EXTENDS']);
      const relIterable: Array<{ sourceId: string; targetId: string; type: string }> = [];
      for (const rel of graph.iterRelationships()) {
        if (allowedEdgeTypes.has(rel.type)) {
          relIterable.push({ sourceId: rel.sourceId, targetId: rel.targetId, type: rel.type });
        }
      }
      const adjMap = buildAdjacencyMap(relIterable, nodeIds);

      timer.mark('build_adjacency');

      // 4. Count graphlets
      const profile = countGraphlets(nodeIterable, adjMap);

      timer.mark('count_graphlets');

      // 5. Detect patterns
      const patterns = detectPatterns(profile);

      timer.mark('detect_patterns');

      // 6. Optionally score health
      let health: ReturnType<typeof scoreArchitectureHealth> | undefined;
      const includeHealth = params.include_health !== false; // default true
      if (includeHealth) {
        // Extract community info from graph
        const communities: CommunityInfo[] = [];
        const communityNodes = graph.findNodesByLabel('Community');
        for (const cNode of communityNodes) {
          const memberCount = cNode.properties.symbolCount as number | undefined;
          if (memberCount !== undefined && memberCount > 0) {
            communities.push({ id: cNode.id, nodeCount: memberCount });
          }
        }
        health = scoreArchitectureHealth(profile, communities, adjMap);
        timer.mark('health_score');
      }

      timer.stop();

      const output = {
        graphletProfile: {
          motif3: profile.motif3,
          motif4: profile.motif4,
          nodeCount: profile.nodeCount,
          edgeCount: profile.edgeCount,
          sampled: profile.sampled,
          sampleSize: profile.sampleSize,
        },
        patterns: patterns.map((p) => ({
          name: p.name,
          confidence: Math.round(p.confidence * 100) / 100,
          description: p.description,
          indicators: p.indicators,
        })),
        health: health ? {
          overallScore: health.overallScore,
          cohesion: health.cohesion,
          modularity: health.modularity,
          complexity: health.complexity,
          antiPatterns: health.antiPatterns,
        } : undefined,
      };

      const nextHint = '\n\nNext: use graph_algorithms({algorithm: "pagerank"}) to identify the most important modules, or cypher({query: {...}}) to explore specific dependency patterns.';
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) + nextHint }] };
    },
  },

  // #464: Security audit tool
  'astrolabe.security_audit': {
    name: 'astrolabe.security_audit',
    description: `Run a security audit on an indexed repository. Detects secrets in code, identifies security-sensitive code patterns, and optionally checks dependencies for known vulnerabilities via OSV.dev.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name (optional if only one indexed)' },
        check_deps: { type: 'boolean', description: 'Check dependencies for vulnerabilities via OSV.dev (default: false)' },
        severity_threshold: { type: 'string', description: 'Minimum severity to report: critical, high, medium, low (default: low)', enum: ['critical', 'high', 'medium', 'low'] },
      },
    },
    handler: async (params) => {
      const repo = params.repo as string | undefined;
      const checkDeps = (params.check_deps as boolean) ?? false;
      const severityThreshold = (params.severity_threshold as string) ?? 'low';

      // #464: Load graph from DB
      const ctx = backend.getRepo(repo);
      const graph = ctx.loadGraph();

      // #464: Import security patterns and scan logic inline to avoid circular deps
      const SECRET_PATTERNS = [
        { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/g, severity: 'critical' },
        { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"][A-Za-z0-9/+=]{40}['"]/gi, severity: 'critical' },
        { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, severity: 'critical' },
        { name: 'GitHub OAuth', pattern: /gho_[A-Za-z0-9]{36}/g, severity: 'critical' },
        { name: 'Slack Token', pattern: /xox[baprs]-[0-9]{10,}-[A-Za-z0-9]+/g, severity: 'high' },
        { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, severity: 'critical' },
        { name: 'JWT', pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, severity: 'medium' },
        { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"][A-Za-z0-9]{20,}['"]/gi, severity: 'high' },
        { name: 'Generic Secret', pattern: /(?:secret|password|token)\s*[=:]\s*['"][A-Za-z0-9!@#$%^&*]{16,}['"]/gi, severity: 'high' },
        { name: 'Google API Key', pattern: /AIza[0-9A-Za-z_-]{35}/g, severity: 'high' },
        { name: 'Stripe Key', pattern: /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{24,}/g, severity: 'critical' },
      ];

      const SECURITY_PATTERNS = [
        { category: 'auth', patterns: [/\b(?:login|authenticate|authorize|logout|session)\b/i], severity: 'medium' },
        { category: 'crypto', patterns: [/\b(?:encrypt|decrypt|hash|sign|verify|cipher|digest)\b/i], severity: 'medium' },
        { category: 'sql', patterns: [/\b(?:executeQuery|rawQuery|\.query\(|sql.*\+|SELECT.*FROM|INSERT.*INTO)\b/i], severity: 'high' },
        { category: 'file-io', patterns: [/\b(?:readFile|writeFile|unlink|rmdir|exec|spawn)\b/i], severity: 'low' },
        { category: 'network', patterns: [/\b(?:fetch|axios|http\.request|XMLHttpRequest|websocket)\b/i], severity: 'info' },
      ];

      const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      const meetsThreshold = (sev: string) => (SEVERITY_ORDER[sev] ?? 4) <= (SEVERITY_ORDER[severityThreshold] ?? 4);

      const findings: Array<Record<string, unknown>> = [];
      let secretCount = 0;
      let securityPatternCount = 0;

      // #464: Scan all nodes
      const binaryExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'zip', 'gz', 'tar', 'wasm']);

      for (const node of graph.iterNodes()) {
        const content = typeof node.properties.content === 'string' ? node.properties.content : '';
        const name = typeof node.properties.name === 'string' ? node.properties.name : '';
        const filePath = typeof node.properties.filePath === 'string' ? node.properties.filePath : '';
        if (!filePath) continue;

        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        if (binaryExtensions.has(ext)) continue;

        // #464: Secret scanning
        if (content) {
          for (const { name: patternName, pattern, severity } of SECRET_PATTERNS) {
            if (!meetsThreshold(severity)) continue;
            const regex = new RegExp(pattern.source, pattern.flags);
            if (regex.test(content)) {
              secretCount++;
              findings.push({
                type: 'secret',
                severity,
                category: patternName,
                message: `Detected ${patternName} in ${node.label} "${name || node.id}"`,
                nodeId: node.id,
                filePath,
              });
            }
          }
        }

        // #464: Security pattern scanning
        const textToScan = [name, content].filter(Boolean).join(' ');
        if (textToScan) {
          for (const { category, patterns, severity } of SECURITY_PATTERNS) {
            if (!meetsThreshold(severity)) continue;
            for (const pat of patterns) {
              const regex = new RegExp(pat.source, pat.flags);
              if (regex.test(textToScan)) {
                securityPatternCount++;
                findings.push({
                  type: 'security-pattern',
                  severity,
                  category,
                  message: `Security-sensitive ${category} pattern in ${node.label} "${name || node.id}"`,
                  nodeId: node.id,
                  filePath,
                });
                break;
              }
            }
          }
        }
      }

      // #464: Optionally check dependencies
      let vulnerabilityReport: Record<string, unknown> | null = null;
      if (checkDeps) {
        try {
          const { detectManifestFiles, parseManifest, checkVulnerabilities } = await import('../analysis/security/vulnerabilities.js');
          const repoPath = ctx.entry.path;
          const manifests = detectManifestFiles(repoPath);
          const allDeps: Array<{ name: string; version: string; ecosystem: string }> = [];
          for (const m of manifests) {
            const deps = parseManifest(m.path, m.ecosystem);
            allDeps.push(...deps);
          }
          if (allDeps.length > 0) {
            vulnerabilityReport = await checkVulnerabilities(allDeps) as unknown as Record<string, unknown>;
          }
        } catch (err) {
          vulnerabilityReport = { error: `Dependency check failed: ${String(err)}` };
        }
      }

      const report = {
        findings,
        summary: {
          totalFindings: findings.length,
          secretCount,
          securityPatternCount,
        },
        vulnerabilities: vulnerabilityReport,
      };

      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    },
  },

  // #463: Coverage report summary
  'astrolabe.coverage_report': {
    name: 'astrolabe.coverage_report',
    description: `Show test coverage summary for an indexed repository, grouped by community/module. Requires coverage data to have been ingested via the ingest-coverage CLI command.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        group_by: { type: 'string', description: 'Group results by: file, community, label', enum: ['file', 'community', 'label'] },
      },
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const groupBy = (params.group_by as string) ?? 'file';

      // Collect all nodes with coverage annotations
      interface CoverageEntry { name: string; label: string; filePath: string; lineCoverage: number; functionCoverage: number; status: string; community?: string }
      const entries: CoverageEntry[] = [];

      // Build community index for grouping
      const communityOf = new Map<string, string>();
      for (const rel of graph.iterRelationships()) {
        if (rel.type === 'MEMBER_OF') {
          const communityNode = graph.getNode(rel.targetId);
          if (communityNode && communityNode.label === 'Community') {
            communityOf.set(rel.sourceId, (communityNode.properties.name as string) ?? communityNode.id);
          }
        }
      }

      for (const node of graph.iterNodes()) {
        const cov = node.properties._coverage as { lineCoverage: number; functionCoverage: number } | undefined;
        if (!cov) continue;

        entries.push({
          name: (node.properties.name as string) ?? node.id,
          label: node.label,
          filePath: (node.properties.filePath as string) ?? '',
          lineCoverage: cov.lineCoverage,
          functionCoverage: cov.functionCoverage,
          status: (node.properties._coverageStatus as string) ?? 'unknown',
          community: communityOf.get(node.id),
        });
      }

      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No coverage data found. Run `astrolabe ingest-coverage <report-file>` first.' }] };
      }

      // Group results
      const groups = new Map<string, CoverageEntry[]>();
      for (const entry of entries) {
        let key: string;
        if (groupBy === 'community') key = entry.community ?? '(unassigned)';
        else if (groupBy === 'label') key = entry.label;
        else key = entry.filePath || '(unknown file)';

        let bucket = groups.get(key);
        if (!bucket) { bucket = []; groups.set(key, bucket); }
        bucket.push(entry);
      }

      // Build output
      const overallLineCov = entries.length > 0
        ? entries.reduce((s, e) => s + e.lineCoverage, 0) / entries.length
        : 0;
      const lines: string[] = [
        `Coverage Summary (${entries.length} entries, grouped by ${groupBy})`,
        `Overall average line coverage: ${overallLineCov.toFixed(1)}%`,
        '',
      ];

      const uncovered = entries.filter((e) => e.status === 'uncovered').length;
      const partial = entries.filter((e) => e.status === 'partial').length;
      const covered = entries.filter((e) => e.status === 'covered').length;
      lines.push(`Status: ${covered} covered, ${partial} partial, ${uncovered} uncovered`);
      lines.push('');

      for (const [group, items] of groups) {
        const avgLine = items.reduce((s, e) => s + e.lineCoverage, 0) / items.length;
        const avgFn = items.reduce((s, e) => s + e.functionCoverage, 0) / items.length;
        lines.push(`## ${group} (${items.length} items, avg line: ${avgLine.toFixed(1)}%, avg fn: ${avgFn.toFixed(1)}%)`);
        for (const item of items.slice(0, 20)) {
          const icon = item.status === 'covered' ? '✓' : item.status === 'partial' ? '◐' : '✗';
          lines.push(`  ${icon} ${item.label}:${item.name} — line ${item.lineCoverage.toFixed(0)}%, fn ${item.functionCoverage.toFixed(0)}%`);
        }
        if (items.length > 20) lines.push(`  ... and ${items.length - 20} more`);
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },

  // #463: Coverage gaps — high-impact uncovered symbols
  'astrolabe.coverage_gaps': {
    name: 'astrolabe.coverage_gaps',
    description: `Find symbols with high impact score but zero test coverage. These are the riskiest untested parts of the codebase.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        min_impact: { type: 'number', description: 'Minimum impact score (incoming edges) to consider' },
      },
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const minImpact = (params.min_impact as number) ?? 2;

      // Count incoming edges per node
      const incomingCount = new Map<string, number>();
      for (const rel of graph.iterRelationships()) {
        incomingCount.set(rel.targetId, (incomingCount.get(rel.targetId) ?? 0) + 1);
      }

      // Find uncovered nodes with high impact
      interface GapEntry { name: string; label: string; filePath: string; startLine: number; incomingEdges: number }
      const gaps: GapEntry[] = [];

      for (const node of graph.iterNodes()) {
        const status = node.properties._coverageStatus as string | undefined;
        if (status !== 'uncovered') continue;

        const impact = incomingCount.get(node.id) ?? 0;
        if (impact < minImpact) continue;

        gaps.push({
          name: (node.properties.name as string) ?? node.id,
          label: node.label,
          filePath: (node.properties.filePath as string) ?? '',
          startLine: (node.properties.startLine as number) ?? 0,
          incomingEdges: impact,
        });
      }

      // Sort by impact (highest first)
      gaps.sort((a, b) => b.incomingEdges - a.incomingEdges);

      if (gaps.length === 0) {
        return { content: [{ type: 'text', text: `No uncovered symbols with >= ${minImpact} incoming edges found. Either no coverage data ingested or all high-impact code is covered.` }] };
      }

      const lines: string[] = [
        `Coverage Gaps: ${gaps.length} uncovered symbols with >= ${minImpact} incoming edges`,
        '',
      ];

      for (const gap of gaps.slice(0, 50)) {
        lines.push(`  ⚠ ${gap.label}:${gap.name} — ${gap.incomingEdges} dependents (${gap.filePath}:${gap.startLine})`);
      }
      if (gaps.length > 50) lines.push(`  ... and ${gaps.length - 50} more`);

      lines.push('');
      lines.push('These symbols have no test coverage but are depended upon by multiple callers. Consider adding tests to reduce risk.');

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },
};

// ── Resources ──────────────────────────────────────────────────────────────

function getResources() {
  return [
    { uri: 'astrolabe://repos', name: 'All Indexed Repositories', description: 'List all indexed repositories with stats', mimeType: 'text/plain' },
    { uri: 'astrolabe://setup', name: 'Astrolabe Setup Content', description: 'Returns AGENTS.md content for all indexed repos. Useful for setup/onboarding.', mimeType: 'text/markdown' },
    { uri: 'astrolabe://repo/{name}/context', name: 'Repo Context', description: 'Codebase overview, stats, staleness check', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/clusters', name: 'Clusters', description: 'All functional clusters with cohesion scores', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/processes', name: 'Processes', description: 'All execution flows', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/schema', name: 'Graph Schema', description: 'Node labels and relationship types', mimeType: 'text/plain' },
  ];
}

// ── Resource Templates (per-entity deep-dive) ────────────────────────────────

function getResourceTemplates() {
  return [
    { uriTemplate: 'astrolabe://repo/{name}/cluster/{clusterId}', name: 'Cluster Details', description: 'Cluster members, cohesion score, entry points, and key symbols', mimeType: 'text/plain' },
    { uriTemplate: 'astrolabe://repo/{name}/process/{processId}', name: 'Process Trace', description: 'Step-by-step execution trace with symbols and edges', mimeType: 'text/plain' },
    { uriTemplate: 'astrolabe://group/{name}/contracts', name: 'Group Contracts', description: 'Cross-repo contract registry with providers, consumers, and cross-links', mimeType: 'text/yaml' },
    { uriTemplate: 'astrolabe://group/{name}/status', name: 'Group Status', description: 'Per-repo index staleness and contract-registry status', mimeType: 'text/yaml' },
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

  // astrolabe://repo/{name}/cluster/{clusterId}
  const ccMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/cluster\/(.+)$/);
  if (ccMatch) {
    try {
      const ctx = backend.getRepo(ccMatch[1]);
      const graph = ctx.loadGraph();
      const clusterId = ccMatch[2];
      const members: string[] = [];
      const memberIds = new Set<string>();
      let cohesion = 0;
      let clusterLabel = clusterId;
      for (const node of graph.iterNodes()) {
        if (node.label !== 'Community') continue;
        if (node.id === clusterId || node.properties.name === clusterId || node.id.includes(clusterId)) {
          if (!node.properties.name) continue;
          clusterLabel = (node.properties.name as string) ?? clusterId;
          cohesion = (node.properties.cohesion as number) ?? 0;
          for (const rel of graph.iterRelationships()) {
            if (rel.type === 'MEMBER_OF' && rel.targetId === node.id) {
              const sym = graph.getNode(rel.sourceId);
              if (sym) {
                members.push(`- ${sym.label.padEnd(12)} ${sym.properties.name ?? '?'} (${sym.properties.filePath ?? '?'})`);
                memberIds.add(sym.id);
              }
            }
          }
          break;
        }
      }
      if (members.length === 0) return `Cluster "${clusterId}" not found.`;

      // Entry points: cluster members that are process entry points
      const entryPoints: string[] = [];
      for (const rel of graph.iterRelationshipsByType('ENTRY_POINT_OF')) {
        if (memberIds.has(rel.sourceId)) {
          const sym = graph.getNode(rel.sourceId);
          if (sym) entryPoints.push(`- ${sym.properties.name ?? sym.id} (${sym.label} — ${sym.properties.filePath ?? '?'})`);
        }
      }

      // Key symbols: members with most intra-cluster connections
      const connCount = new Map<string, number>();
      for (const rel of graph.iterRelationships()) {
        if (rel.type === 'STEP_IN_PROCESS' || rel.type === 'MEMBER_OF' || rel.type === 'ENTRY_POINT_OF') continue;
        if (memberIds.has(rel.sourceId) && memberIds.has(rel.targetId)) {
          connCount.set(rel.sourceId, (connCount.get(rel.sourceId) ?? 0) + 1);
          connCount.set(rel.targetId, (connCount.get(rel.targetId) ?? 0) + 1);
        }
      }
      const keySymbols = Array.from(connCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, count]) => {
          const sym = graph.getNode(id);
          return `- ${sym?.properties.name ?? id} (${count} connections)`;
        });

      const parts = [`Cluster: ${clusterLabel}`, `Cohesion: ${cohesion}`, '', 'Members:', ...members];
      if (entryPoints.length > 0) parts.push('', 'Entry Points:', ...entryPoints);
      if (keySymbols.length > 0) parts.push('', 'Key Symbols:', ...keySymbols);
      return parts.join('\n');
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

  // astrolabe://repo/{name}/process/{processId}
  const ptMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/process\/(.+)$/);
  if (ptMatch) {
    try {
      const ctx = backend.getRepo(ptMatch[1]);
      const graph = ctx.loadGraph();
      const processId = ptMatch[2];
      let processNode: GraphNode | undefined;
      const steps: Array<{ step: number; name: string; label: string; filePath: string; id: string }> = [];

      for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
        const proc = graph.getNode(rel.sourceId);
        if (proc && (proc.id === processId || proc.properties.name === processId)) {
          if (!processNode) processNode = proc;
          const sym = graph.getNode(rel.targetId);
          if (sym) {
            steps.push({
              step: rel.step ?? 0,
              name: (sym.properties.name as string) ?? sym.id,
              label: sym.label,
              filePath: (sym.properties.filePath as string) ?? '?',
              id: sym.id,
            });
          }
        }
      }

      if (steps.length === 0) return 'Process not found.';
      steps.sort((a, b) => a.step - b.step);

      // Find edges between step symbols
      const stepIds = new Set(steps.map(s => s.id));
      const edges: string[] = [];
      for (const rel of graph.iterRelationships()) {
        if (rel.type === 'STEP_IN_PROCESS' || rel.type === 'MEMBER_OF') continue;
        if (stepIds.has(rel.sourceId) && stepIds.has(rel.targetId)) {
          const srcName = graph.getNode(rel.sourceId)?.properties.name ?? rel.sourceId;
          const tgtName = graph.getNode(rel.targetId)?.properties.name ?? rel.targetId;
          edges.push(`- ${srcName} → ${rel.type} → ${tgtName}`);
        }
      }

      const processType = (processNode?.properties.processType as string) ?? 'intra_community';
      const stepCount = (processNode?.properties.stepCount as number) ?? steps.length;
      const parts = [
        `Process: ${processNode?.properties.name ?? processId}`,
        `Type: ${processType}`,
        `Steps: ${stepCount}`,
        '',
        'Trace:',
        ...steps.map(s => `Step ${s.step}: ${s.name} (${s.label} — ${s.filePath})`),
      ];
      if (edges.length > 0) parts.push('', 'Edges:', ...edges);
      return parts.join('\n');
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
      return `Node Labels: File, Folder, Package, Function, Class, Method, Interface, Enum, Variable, Import, Community, Process, Route, Tool, Section, Framework\nRelationship Types: ACCESSES, CONTAINS, CALLS, EXTENDS, IMPLEMENTS, IMPORTS, USES, DEFINES, HAS_METHOD, HAS_PROPERTY, MEMBER_OF, STEP_IN_PROCESS, HANDLES_ROUTE, ENTRY_POINT_OF, USES_FRAMEWORK`;
    }
  }

  // #404: astrolabe://setup — AGENTS.md content for all indexed repos
  if (uri === 'astrolabe://setup') {
    return generateSetupResource();
  }

  // #399: astrolabe://group/{name}/contracts — contract registry
  const gcMatch = uri.match(/^astrolabe:\/\/group\/([^/]+)\/(contracts|status)$/);
  if (gcMatch) {
    const groupName = gcMatch[1];
    const resourceType = gcMatch[2];
    if (resourceType === 'status') {
      return generateGroupStatusResource(groupName);
    }
    return generateGroupContractsResource(groupName, uri);
  }

  return null;
}

/**
 * #404: Read AGENTS.md files from all indexed repos and combine them.
 * Useful for setup/onboarding when an AI agent first connects.
 */
function generateSetupResource(): string {
  const repos = backend.listRepos();

  if (repos.length === 0) {
    return '# Astrolabe\n\nNo repositories indexed. Run: `astrolabe analyze <path>` in a repository.';
  }

  const sections: string[] = [];

  for (const repo of repos) {
    const agentsPath = pathJoin(repo.path, 'AGENTS.md');
    if (existsSync(agentsPath)) {
      const content = readFileSync(agentsPath, 'utf-8');
      sections.push(`# ${repo.name}\n\n${content}`);
    }
  }

  if (sections.length === 0) {
    return '# Astrolabe\n\nNo AGENTS.md files found in indexed repositories.';
  }

  return sections.join('\n\n---\n\n');
}

/**
 * #399: Generate group status resource content.
 */
function generateGroupStatusResource(groupName: string): string {
  try {
    const status = getGroupStatus(groupName);
    const lines: string[] = [`group: "${status.name}"`, `repos: ${status.repoCount}`, '', 'members:'];
    for (const repo of status.repos) {
      const icon = repo.stale ? '⚠ STALE' : '✓ current';
      const indexed = repo.indexedAt ? new Date(repo.indexedAt).toISOString() : 'never';
      lines.push(`  - path: "${repo.path}"`);
      lines.push(`    repo: "${repo.repoName}"`);
      lines.push(`    status: "${icon}"`);
      lines.push(`    indexed: "${indexed}"`);
      if (repo.lastCommit) lines.push(`    commit: "${repo.lastCommit.substring(0, 7)}"`);
      if (repo.nodeCount !== undefined) lines.push(`    symbols: ${repo.nodeCount}`);
      if (repo.edgeCount !== undefined) lines.push(`    edges: ${repo.edgeCount}`);
    }
    return lines.join('\n');
  } catch (e: any) {
    return `error: ${e.message}`;
  }
}

/**
 * #399: Generate group contracts resource content.
 * Supports optional query params: ?type=, ?repo=, ?unmatchedOnly=true|false
 */
function generateGroupContractsResource(groupName: string, uri: string): string {
  try {
    const contracts = getGroupContracts(groupName);
    if (!contracts) {
      return `group: "${groupName}"\ncontracts: []\n# No contracts extracted. Run group_sync first.`;
    }

    // Parse query params from URI
    let filterType: string | undefined;
    let filterRepo: string | undefined;
    let unmatchedOnly: boolean | undefined;
    try {
      const u = new URL(uri);
      filterType = u.searchParams.get('type')?.trim() || undefined;
      filterRepo = u.searchParams.get('repo')?.trim() || undefined;
      const uo = u.searchParams.get('unmatchedOnly');
      if (uo === 'true' || uo === '1') unmatchedOnly = true;
      else if (uo === 'false' || uo === '0') unmatchedOnly = false;
    } catch { /* no query params */ }

    // Apply filters
    let crossLinks = contracts.crossLinks;
    if (filterType === 'http' || !filterType) { /* HTTP is default, all current links are HTTP */ }
    if (filterRepo) {
      crossLinks = crossLinks.filter((cl) =>
        cl.provider.repoName === filterRepo || cl.consumer.repoName === filterRepo);
    }
    if (unmatchedOnly) {
      crossLinks = crossLinks.filter((cl) => cl.confidence < 0.5);
    }

    const lines: string[] = [
      `group: "${groupName}"`,
      `extracted: "${new Date(contracts.extractedAt).toISOString()}"`,
      `providers: ${contracts.providers.length}`,
      `consumers: ${contracts.consumers.length}`,
      `crossLinks: ${crossLinks.length}`,
      '',
    ];

    if (crossLinks.length > 0) {
      lines.push('contracts:');
      for (const cl of crossLinks.slice(0, 50)) {
        lines.push(`  - provider: "${cl.provider.repoName} ${cl.provider.method} ${cl.provider.path}"`);
        lines.push(`    consumer: "${cl.consumer.repoName} ${cl.consumer.functionName}"`);
        lines.push(`    confidence: ${cl.confidence.toFixed(2)}`);
      }
      if (crossLinks.length > 50) lines.push(`  # ... and ${crossLinks.length - 50} more`);
    }

    return lines.join('\n');
  } catch (e: any) {
    return `error: ${e.message}`;
  }
}

// ── Prompts ────────────────────────────────────────────────────────────────

function getPrompts() {
  return [
    {
      name: 'detect_impact',
      description: 'Pre-commit change analysis workflow — detect changes, gather context, analyze impact, produce a risk report',
      arguments: [
        { name: 'repoPath', description: 'Repository path or name to analyze', required: true },
      ],
    },
    {
      name: 'generate_map',
      description: 'Architecture documentation workflow — query, context, community detection, process tracing, mermaid diagram',
      arguments: [
        { name: 'repoPath', description: 'Repository path or name to document', required: true },
        { name: 'format', description: 'Output format: "mermaid" (default) or "markdown"', required: false },
      ],
    },
    {
      name: 'refactor_safety',
      description: 'Safe refactor workflow — gather context, analyze impact, verify rename safety before refactoring',
      arguments: [
        { name: 'repoPath', description: 'Repository path or name containing the symbol', required: true },
        { name: 'symbol', description: 'Symbol name to refactor', required: true },
      ],
    },
  ];
}

function getPromptMessages(name: string, args: Record<string, string>) {
  if (name === 'detect_impact') {
    const repo = args.repoPath ?? '';
    const repoArg = repo ? `, repo: "${repo}"` : '';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Perform a pre-commit change impact analysis for the repository${repo ? ` "${repo}"` : ''}. Follow these steps in order:

**Step 1 — Detect Changes**
Call: \`astrolabe.detect_changes({scope: "unstaged"${repoArg}})\`
Identify which files have been modified and which symbols are affected.

**Step 2 — Gather Context**
For each changed symbol returned in Step 1, call: \`astrolabe.context({name: "<symbol>"${repoArg}})\`
Understand what each changed symbol does, who calls it, and what it depends on.

**Step 3 — Analyze Impact**
For each changed symbol, call: \`astrolabe.impact({target: "<symbol>", direction: "upstream"${repoArg}})\`
Determine the blast radius — what else depends on the changed code.

**Step 4 — Produce Risk Report**
Summarize your findings:
- List all changed files and symbols
- Group affected downstream dependencies by risk level (WILL BREAK, LIKELY AFFECTED, MAYBE AFFECTED)
- Flag any cross-community process impacts (higher risk)
- Give a clear GO / NO-GO recommendation for committing`,
        },
      },
    ];
  }

  if (name === 'generate_map') {
    const repo = args.repoPath ?? '';
    const format = args.format ?? 'mermaid';
    const repoLabel = repo ? ` "${repo}"` : '';
    const repoArg = repo ? `, repo: "${repo}"` : '';
    const mermaidStep = format === 'mermaid'
      ? `**Step 5 — Generate Mermaid Diagram**
Call: \`astrolabe.generate_diagram({diagram_type: "community"${repoArg}})\`
This produces a Mermaid graph with communities as subgraphs, member symbols as nodes,
and CALLS/IMPORTS/EXTENDS/IMPLEMENTS relationships as edges.

For process flows, call: \`astrolabe.generate_diagram({diagram_type: "process"${repoArg}})\`
For dependency graphs, call: \`astrolabe.generate_diagram({diagram_type: "dependency"${repoArg}})\`
For class hierarchies, call: \`astrolabe.generate_diagram({diagram_type: "class_hierarchy"${repoArg}})\``
      : `**Step 5 — Generate Markdown Documentation**
Call: \`astrolabe.generate_diagram({diagram_type: "community", format: "markdown"${repoArg}})\`
This produces a Markdown document with architecture overview, per-cluster details, and stats.`;
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Generate architecture documentation for the repository${repoLabel}. Follow these steps in order:

**Step 1 — Discover Repositories**
Call: \`astrolabe.list_repos()\`
Identify the available indexed repositories${repo ? ` and find "${repo}"` : ''}.

**Step 2 — Query Key Symbols**
Call: \`astrolabe.query({query: "main"${repo ? `, repo: "${repo}"` : ''}})\`
Then call: \`astrolabe.query({query: "route"${repo ? `, repo: "${repo}"` : ''}})\`
Find entry points, routes, and top-level architectural elements.

**Step 3 — Read Context and Clusters**
Read resource: \`astrolabe://repo/{name}/context\` for overview stats.
Read resource: \`astrolabe://repo/{name}/clusters\` for functional areas (communities).
Read resource: \`astrolabe://repo/{name}/schema\` for available node/edge types.

**Step 4 — Trace Processes**
Read resource: \`astrolabe://repo/{name}/processes\` for execution flows.
For important processes, read: \`astrolabe://repo/{name}/process/{processName}\` for step-by-step traces.

${mermaidStep}

**Step 6 — Document Each Cluster**
For each cluster found in Step 3, describe:
- Purpose and responsibility
- Key entry points and exported symbols
- Intra-cluster and cross-cluster dependencies`,
        },
      },
    ];
  }

  if (name === 'refactor_safety') {
    const repo = args.repoPath ?? '';
    const symbol = args.symbol ?? '';
    const repoArg = repo ? `, repo: "${repo}"` : '';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Perform a safe refactor analysis for the symbol "${symbol}"${repo ? ` in repository "${repo}"` : ''}. Follow these steps in order:

**Step 1 — Gather Full Context**
Call: \`astrolabe.context({name: "${symbol}"${repoArg}})\`
Understand the symbol's type, file location, incoming dependencies (who depends on it), outgoing dependencies (what it calls), and which processes it participates in.

**Step 2 — Analyze Impact**
Call: \`astrolabe.impact({target: "${symbol}", direction: "upstream"${repoArg}})\`
Determine the blast radius of modifying this symbol — how many callers and dependents will be affected.

Call: \`astrolabe.impact({target: "${symbol}", direction: "downstream"${repoArg}})\`
Determine what this symbol depends on — critical for understanding side effects of changes.

**Step 3 — Verify Rename Safety**
Call: \`astrolabe.rename({symbol_name: "${symbol}", new_name: "<proposed_new_name>", dry_run: true${repoArg}})\`
Preview the rename across all files. Check:
- How many files would be affected
- Whether any references are ambiguous (multiple symbols with same name)
- Whether graph references vs text search references differ in count

**Step 4 — Safety Assessment**
Provide a safety report:
- Total number of upstream dependents (callers that will break)
- Total number of downstream dependencies (things that might change behavior)
- Process membership (is this symbol part of cross-community processes?)
- Rename scope (how many files, any ambiguities)
- Overall safety rating: SAFE / CAUTION / DANGEROUS
- Specific risks and recommendations`,
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
        result: { resources: [...getResources(), ...getResourceTemplates()] },
      };

    case 'resources/templates/list':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: { resourceTemplates: getResourceTemplates() },
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

export interface McpServerOptions {
  /** Transport type: 'stdio' (default) or 'http' (StreamableHTTP). */
  transport?: 'stdio' | 'http';
  /** Port for HTTP transport. Default: 4748. Only used when transport is 'http'. */
  port?: number;
  /** Host for HTTP transport. Default: 'localhost'. Only used when transport is 'http'. */
  host?: string;
}

export async function startMcpServer(options?: McpServerOptions): Promise<void> {
  const transportType = options?.transport ?? 'stdio';

  // ── HTTP (StreamableHTTP) transport ────────────────────────────────────
  if (transportType === 'http') {
    const httpTransport = new StreamableHttpTransport({
      port: options?.port,
      host: options?.host,
    });

    await httpTransport.listen();
    const addr = httpTransport.address ?? `http://localhost:${options?.port ?? 4748}`;
    console.error(`Astrolabe MCP server (StreamableHTTP) listening on ${addr}/mcp`);

    // Graceful shutdown
    process.on('SIGINT', () => { backend.shutdown(); httpTransport.close(); process.exit(0); });
    process.on('SIGTERM', () => { backend.shutdown(); httpTransport.close(); process.exit(0); });

    httpTransport.on('message', async (data: unknown) => {
      try {
        const req = data as JsonRpcRequest;
        const res = await handleRequest(req);
        if (res !== null) {
          httpTransport.send(res);
        }
      } catch {
        // Parse error already handled by transport
      }
    });

    httpTransport.on('error', (err: Error) => {
      console.error('MCP HTTP transport error:', err.message);
    });
    return;
  }

  // ── Stdio transport (default) ──────────────────────────────────────────
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
