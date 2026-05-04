/**
 * Hybrid Search — combines BM25 (FTS) + semantic vector search (#261).
 *
 * Merges results from both search methods using Reciprocal Rank Fusion (RRF)
 * with configurable K parameter. This provides the best of both worlds:
 * exact keyword matching from FTS and semantic similarity from embeddings.
 */

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
  /** Combined RRF score (higher = better). */
  combinedScore: number;
  /** Metadata from the FTS result. */
  name?: string;
  label?: string;
  filePath?: string;
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

// ── Hybrid search ──────────────────────────────────────────────────────────

/**
 * Hybrid search combining FTS (keyword) and vector (semantic) results.
 *
 * Reciprocal Rank Fusion (RRF):
 *   RRF(d, q) = Σ_{i in methods} 1 / (k + rank_i(d))
 *
 * Where k=60 (standard), and rank_i(d) starts at 1.
 *
 * @returns Combined results sorted by RRF score descending.
 */
export async function hybridSearch(
  query: string,
  fts: FtsSearch,
  store: EmbeddingStore,
  provider: EmbeddingProvider,
  limit = 20,
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
  const results = Array.from(rrfScores.entries()).map(([nodeId, entry]) => ({
    nodeId,
    ...entry,
  }));

  return results
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);
}
