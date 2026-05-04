/**
 * Hybrid Search — combines BM25 (FTS) + semantic vector search (#261).
 *
 * Merges results from both search methods using Reciprocal Rank Fusion (RRF)
 * with configurable K parameter. This provides the best of both worlds:
 * exact keyword matching from FTS and semantic similarity from embeddings.
 *
 * Community cohesion boost: results from tightly-knit modules rank higher.
 * When a graph is provided, the cohesion of each result's community is computed
 * as the ratio of internal coupling edges to total coupling edges, and the
 * RRF score is scaled: combinedScore *= (1 + cohesionBoost * cohesion).
 */

import type { KnowledgeGraph, RelationshipType } from '@astrolabe/shared';
import type { FtsSearch } from './fts.js';
import { EmbeddingStore } from './embeddings-store.js';
import type { EmbeddingProvider } from './embeddings-store.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface HybridResult {
  nodeId: string;
  /** FTS rank (lower = better, from BM25). */
  ftsRank: number;
  /** Vector similarity score (0-1, higher = better). */
  vectorScore: number;
  /** Combined RRF score (higher = better). After cohesion boost if graph provided. */
  combinedScore: number;
  /** Metadata from the FTS result. */
  name?: string;
  label?: string;
  filePath?: string;
  /** Process type classification (intra_community vs cross_community). */
  processType?: 'intra_community' | 'cross_community';
  /** Number of steps in the process this node belongs to. */
  stepCount?: number;
  /** Cohesion-weighted priority score. */
  priority?: number;
}

/** Optional configuration for hybrid search with graph awareness. */
export interface HybridSearchOptions {
  /** Knowledge graph for community cohesion boosting. */
  graph?: KnowledgeGraph;
  /** Cohesion boost factor applied to tightly-knit communities (default: 0.15). */
  cohesionBoost?: number;
}

// ── RRF constants ──────────────────────────────────────────────────────────

/** RRF K parameter — dampens rank differences. Standard value is 60. */
const RRF_K = 60;

// ── Vector search ──────────────────────────────────────────────────────────

/**
 * Cosine similarity between two Float32Arrays.
 */
export function cosineSimilarityVec(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
  }
  normB = b.reduce((s, v) => s + v * v, 0);
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Search stored embeddings by vector similarity to the query.
 * Async — supports both sync and async (ML) embedding providers (#415).
 */
export async function searchVector(
  queryText: string,
  store: EmbeddingStore,
  provider: EmbeddingProvider,
  limit = 20,
): Promise<Array<{ nodeId: string; score: number }>> {
  const queryVec = provider.encodeAsync
    ? await provider.encodeAsync(queryText)
    : provider.encode(queryText);
  const all = store.getAll();
  if (all.length === 0) return [];

  const scored = all.map((entry) => ({
    nodeId: entry.nodeId,
    score: cosineSimilarityVec(
      queryVec,
      new Float32Array(entry.vector.buffer),
    ),
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Cohesion boost ──────────────────────────────────────────────────────────

/** Relationship types that indicate functional coupling for cohesion computation. */
const COUPLING_TYPES: readonly RelationshipType[] = [
  'CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'DEFINES',
] as const;

/** Default cohesion boost factor. */
const DEFAULT_COHESION_BOOST = 0.15;

/**
 * Build node→community map and compute cohesion per community.
 *
 * Cohesion = internal coupling edges / total coupling edges for the community.
 * A community where most edges stay internal (high cohesion) is tightly-knit.
 */
function computeCommunityCohesion(
  graph: KnowledgeGraph,
): {
  nodeToCommunity: Map<string, string>;
  cohesion: Map<string, number>;
} {
  const nodeToCommunity = new Map<string, string>();

  // Build node → community map from MEMBER_OF edges
  for (const rel of graph.iterRelationshipsByType('MEMBER_OF')) {
    nodeToCommunity.set(rel.sourceId, rel.targetId);
  }

  if (nodeToCommunity.size === 0) {
    return { nodeToCommunity, cohesion: new Map() };
  }

  // Count internal vs total coupling edges per community
  const edgeCounts = new Map<string, { internal: number; total: number }>();

  for (const type of COUPLING_TYPES) {
    for (const rel of graph.iterRelationshipsByType(type)) {
      const srcComm = nodeToCommunity.get(rel.sourceId);
      const tgtComm = nodeToCommunity.get(rel.targetId);

      if (srcComm) {
        let counts = edgeCounts.get(srcComm);
        if (!counts) { counts = { internal: 0, total: 0 }; edgeCounts.set(srcComm, counts); }
        counts.total++;
        if (srcComm === tgtComm) counts.internal++;
      }
      if (tgtComm && tgtComm !== srcComm) {
        let counts = edgeCounts.get(tgtComm);
        if (!counts) { counts = { internal: 0, total: 0 }; edgeCounts.set(tgtComm, counts); }
        counts.total++;
      }
    }
  }

  // Compute cohesion ratio per community
  const cohesion = new Map<string, number>();
  for (const [comm, counts] of edgeCounts) {
    cohesion.set(comm, counts.total > 0 ? counts.internal / counts.total : 0);
  }

  return { nodeToCommunity, cohesion };
}

/**
 * Determine process type (intra/cross community) and step count for a node.
 */
function getProcessInfo(
  nodeId: string,
  graph: KnowledgeGraph,
  nodeToCommunity: Map<string, string>,
): Pick<HybridResult, 'processType' | 'stepCount'> {
  const nodeComm = nodeToCommunity.get(nodeId);
  let stepCount = 0;
  let crossCommunity = false;

  for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
    // STEP_IN_PROCESS edges go from process → step node
    if (rel.targetId === nodeId) {
      stepCount++;
      // Check if the process entry point is in a different community
      const processComm = nodeToCommunity.get(rel.sourceId);
      if (nodeComm && processComm && processComm !== nodeComm) {
        crossCommunity = true;
      }
    }
  }

  if (stepCount === 0) return {};

  return {
    processType: crossCommunity ? 'cross_community' : 'intra_community',
    stepCount,
  };
}

/**
 * Apply community cohesion boost to hybrid search results.
 *
 * Results from tightly-knit communities (high internal edge ratio) rank higher.
 * Boost formula: finalScore = rrfScore * (1 + boost * cohesion)
 *
 * Also enriches results with process metadata (processType, stepCount, priority).
 */
function applyCohesionBoost(
  results: HybridResult[],
  graph: KnowledgeGraph,
  boost = DEFAULT_COHESION_BOOST,
): HybridResult[] {
  const { nodeToCommunity, cohesion } = computeCommunityCohesion(graph);

  if (nodeToCommunity.size === 0) return results;

  for (const r of results) {
    const community = nodeToCommunity.get(r.nodeId);
    if (!community) continue;

    const commCohesion = cohesion.get(community) ?? 0;
    r.combinedScore = r.combinedScore * (1 + boost * commCohesion);
    r.priority = r.combinedScore;

    // Enrich with process info
    const processInfo = getProcessInfo(r.nodeId, graph, nodeToCommunity);
    if (processInfo.processType) r.processType = processInfo.processType;
    if (processInfo.stepCount) r.stepCount = processInfo.stepCount;
  }

  return results.sort((a, b) => b.combinedScore - a.combinedScore);
}

// ── Hybrid search ──────────────────────────────────────────────────────────

/**
 * Hybrid search combining FTS (keyword) and vector (semantic) results.
 *
 * Reciprocal Rank Fusion (RRF):
 *   RRF(d, q) = Σ_{i in methods} 1 / (k + rank_i(d))
 *
 * Where k=60 (standard), and rank_i(d) starts at 1.
 *
 * When a graph is provided via options, a community cohesion boost is applied:
 * results from tightly-knit communities (high ratio of internal coupling edges)
 * receive a score boost proportional to their cohesion.
 *
 * @returns Combined results sorted by (boosted) RRF score descending.
 */
export async function hybridSearch(
  query: string,
  fts: FtsSearch,
  store: EmbeddingStore,
  provider: EmbeddingProvider,
  limit = 20,
  options?: HybridSearchOptions,
): Promise<HybridResult[]> {
  // Run both searches in parallel
  const ftsResults = fts.search(query, 50); // fetch more for RRF
  const vecResults = await searchVector(query, store, provider, 50);

  // Build RRF score map
  const rrfScores = new Map<string, { ftsRank: number; vectorScore: number; combinedScore: number; name?: string; label?: string; filePath?: string }>();

  // FTS contributions (lower rank = higher score from BM25 = better)
  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i];
    const rank = i + 1;
    const rrf = 1 / (RRF_K + rank);
    if (!rrfScores.has(r.nodeId)) {
      rrfScores.set(r.nodeId, {
        ftsRank: rank,
        vectorScore: 0,
        combinedScore: rrf,
        name: r.name,
        label: r.label,
        filePath: r.filePath,
      });
    } else {
      const entry = rrfScores.get(r.nodeId)!;
      entry.ftsRank = rank;
      entry.combinedScore += rrf;
    }
  }

  // Vector contributions (higher score = better = lower RRF rank)
  for (let i = 0; i < vecResults.length; i++) {
    const r = vecResults[i];
    const rank = i + 1;
    const rrf = 1 / (RRF_K + rank);
    if (!rrfScores.has(r.nodeId)) {
      rrfScores.set(r.nodeId, {
        ftsRank: Infinity,
        vectorScore: r.score,
        combinedScore: rrf,
      });
    } else {
      const entry = rrfScores.get(r.nodeId)!;
      entry.vectorScore = r.score;
      entry.combinedScore += rrf;
    }
  }

  // Sort by combined RRF score descending
  let results = Array.from(rrfScores.entries()).map(([nodeId, entry]) => ({
    nodeId,
    ...entry,
  }));

  // Apply community cohesion boost when graph is provided
  if (options?.graph) {
    results = applyCohesionBoost(results, options.graph, options.cohesionBoost);
  }

  return results
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);
}
