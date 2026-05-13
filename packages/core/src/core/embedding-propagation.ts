/**
 * Embedding Propagation — LLM embeddings + graph structure enrichment (#813).
 *
 * Computes semantic embeddings for source code nodes, propagates them along
 * graph edges (neighbor averaging), and creates SEMANTICALLY_SIMILAR virtual
 * edges between nodes with high cosine similarity.
 *
 * Pipeline:
 *   computeEmbeddings() → propagateEmbeddings() → createSemanticEdges()
 */

import { createHash } from 'node:crypto';
import {
  EmbeddingStore,
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderType,
} from '../search/embeddings-store.js';
import Database from 'better-sqlite3';
import type { KnowledgeGraph, RelationshipType, GraphNode } from '@astrolabe-dev/shared';

export type { EmbeddingProvider, EmbeddingProviderType };

/** Result of computeEmbeddings or propagateEmbeddings. */
export interface PropagationResult {
  embeddings: Map<string, number[]>;
  dimensions: number;
  nodeCount: number;
}

/** Result of createSemanticEdges. */
export interface SemanticEdgeResult {
  edgesAdded: number;
  threshold: number;
  provider: string;
  nodeCount: number;
}

/** Options for computeEmbeddings. */
export interface ComputeEmbeddingsOptions {
  /** Embedding provider type (default: auto). */
  provider?: EmbeddingProviderType;
  /** Optional pre-built EmbeddingStore (if saved to DB). */
  store?: EmbeddingStore;
  /** Optional database path for persisting to embeddings table. */
  dbPath?: string;
}

// ── Cosine similarity ──────────────────────────────────────────────────────

/**
 * Cosine similarity between two numeric vectors.
 * Returns 0.0 for zero-norm vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Content extraction ─────────────────────────────────────────────────────

/**
 * Extract a text representation of a node for embedding.
 * Uses sourceText if available, otherwise falls back to label + name.
 */
function nodeToText(node: GraphNode): string {
  const sourceText = node.properties.sourceText as string | undefined;
  if (sourceText && sourceText.length > 0) {
    // Truncate very long source texts to avoid blowing up token counts
    return sourceText.slice(0, 2048);
  }
  const name = (node.properties.name as string) ?? '';
  const label = node.label;
  return `${label}: ${name}`;
}

/** SHA1 content hash for deduplication / cache invalidation. */
function contentHash(node: GraphNode): string {
  return createHash('sha1').update(nodeToText(node)).digest('hex');
}

// ── computeEmbeddings ──────────────────────────────────────────────────────

/**
 * Compute semantic embeddings for all nodes in a knowledge graph.
 *
 * For each node, extracts its textual representation (sourceText or label+name),
 * encodes it via the embedding provider, and stores the result.
 *
 * If dbPath is provided, embeddings are persisted to the embeddings SQLite table
 * for use by hybrid search and future MCP queries.
 *
 * @param graph     Knowledge graph to embed.
 * @param options   Provider selection and optional DB persistence.
 * @returns         Map of nodeId → embedding vector, plus metadata.
 */
export async function computeEmbeddings(
  graph: KnowledgeGraph,
  options: ComputeEmbeddingsOptions = {},
): Promise<PropagationResult> {
  const provider = createEmbeddingProvider(options.provider ?? 'auto');
  const store = options.dbPath
    ? new EmbeddingStore(new Database(options.dbPath))
    : undefined;

  const embeddings = new Map<string, number[]>();
  const nodes: GraphNode[] = [];

  for (const node of graph.iterNodes()) {
    // Skip structural-only nodes without meaningful content
    const text = nodeToText(node);
    if (text.length < 3) continue;
    nodes.push(node);
  }

  // Process nodes in batches for efficiency with async providers
  for (const node of nodes) {
    const text = nodeToText(node);
    const hash = contentHash(node);

    // Check cache in store first
    if (store) {
      const cached = store.get(node.id);
      if (cached && cached.contentHash === hash) {
        embeddings.set(node.id, Array.from(new Float32Array(cached.vector.buffer)));
        continue;
      }
    }

    // Encode — use async path if available
    const vec = provider.encodeAsync
      ? await provider.encodeAsync(text)
      : provider.encode(text);
    const vecArray = Array.from(vec);
    embeddings.set(node.id, vecArray);

    // Persist to store
    if (store) {
      store.upsert(node.id, hash, vec);
    }
  }

  store?.close?.();

  return {
    embeddings,
    dimensions: provider.dimensions,
    nodeCount: embeddings.size,
  };
}

// ── propagateEmbeddings ────────────────────────────────────────────────────

/**
 * Propagate embeddings along graph edges by averaging each node's embedding
 * with its neighbors' embeddings.
 *
 * 1-hop: each node's embedding = 0.5 * self + 0.5 * mean(neighbors)
 * 2-hop: adds information from neighbors of neighbors with decay factor 0.25
 *
 * @param graph        Knowledge graph providing the adjacency structure.
 * @param embeddings   Initial node embeddings (from computeEmbeddings).
 * @param hops         Propagation depth: 0 (no-op), 1, or 2.
 * @returns            Updated Map<nodeId, number[]>.
 */
export function propagateEmbeddings(
  graph: KnowledgeGraph,
  embeddings: Map<string, number[]>,
  hops: number = 1,
): Map<string, number[]> {
  if (hops <= 0) return new Map(embeddings);

  // Build adjacency: Map<nodeId, neighborId[]>
  const adj = new Map<string, string[]>();
  for (const rel of graph.iterRelationships()) {
    // Skip SEMANTICALLY_SIMILAR edges — avoid feedback loop
    if (rel.type === 'SEMANTICALLY_SIMILAR') continue;

    // Add bidirectional edges
    let srcNeighbors = adj.get(rel.sourceId);
    if (!srcNeighbors) {
      srcNeighbors = [];
      adj.set(rel.sourceId, srcNeighbors);
    }
    if (!srcNeighbors.includes(rel.targetId)) srcNeighbors.push(rel.targetId);

    let tgtNeighbors = adj.get(rel.targetId);
    if (!tgtNeighbors) {
      tgtNeighbors = [];
      adj.set(rel.targetId, tgtNeighbors);
    }
    if (!tgtNeighbors.includes(rel.sourceId)) tgtNeighbors.push(rel.sourceId);
  }

  let current = new Map(embeddings);
  for (let hop = 0; hop < hops; hop++) {
    const next = new Map<string, number[]>();
    for (const [nodeId, vec] of current) {
      const neighborIds = adj.get(nodeId);
      if (!neighborIds || neighborIds.length === 0) {
        next.set(nodeId, [...vec]);
        continue;
      }

      // Compute mean of neighbors
      const dims = vec.length;
      const mean: number[] = new Array(dims).fill(0);
      let neighborCount = 0;
      for (const nid of neighborIds) {
        const nvec = current.get(nid);
        if (!nvec) continue;
        for (let i = 0; i < dims; i++) {
          mean[i] += nvec[i];
        }
        neighborCount++;
      }
      if (neighborCount > 0) {
        for (let i = 0; i < dims; i++) {
          mean[i] /= neighborCount;
        }
      }

      // Blend: 0.5 * self + 0.5 * neighbor_mean
      const decay = hop === 0 ? 0.5 : 0.25; // 1st hop: 50/50, 2nd hop: 25% neighbors
      const blended: number[] = new Array(dims);
      if (neighborCount > 0) {
        for (let i = 0; i < dims; i++) {
          blended[i] = (1 - decay) * vec[i] + decay * mean[i];
        }
      } else {
        for (let i = 0; i < dims; i++) {
          blended[i] = vec[i];
        }
      }
      next.set(nodeId, blended);
    }
    current = next;
  }
  return current;
}

// ── typeAwarePropagation ───────────────────────────────────────────────────

/**
 * Type-aware embedding propagation: aggregates neighbor embeddings separately
 * per edge type.
 *
 * Returns a map of { edgeType → Map<nodeId, aggregated_vector> } where each
 * vector represents the mean embedding of neighbors connected by that edge type.
 *
 * Useful for understanding which semantic aspects are carried by which
 * relationship types (e.g., CALLS vs IMPORTS vs EXTENDS).
 *
 * @param graph        Knowledge graph.
 * @param embeddings   Node embeddings.
 * @param edgeTypes    Specific edge types to aggregate (default: all types).
 * @returns            Per-edge-type aggregation results.
 */
export function typeAwarePropagation(
  graph: KnowledgeGraph,
  embeddings: Map<string, number[]>,
  edgeTypes?: RelationshipType[],
): Map<RelationshipType, Map<string, number[]>> {
  const result = new Map<RelationshipType, Map<string, number[]>>();

  // Determine which edge types to process
  const typesToProcess: RelationshipType[] = edgeTypes ?? [];
  if (typesToProcess.length === 0) {
    // Collect all unique edge types from the graph
    const seen = new Set<RelationshipType>();
    for (const rel of graph.iterRelationships()) {
      seen.add(rel.type);
    }
    for (const t of seen) typesToProcess.push(t);
  }

  for (const edgeType of typesToProcess) {
    // Build type-specific adjacency
    const adj = new Map<string, string[]>();
    for (const rel of graph.iterRelationshipsByType(edgeType)) {
      let srcNeighbors = adj.get(rel.sourceId);
      if (!srcNeighbors) {
        srcNeighbors = [];
        adj.set(rel.sourceId, srcNeighbors);
      }
      srcNeighbors.push(rel.targetId);

      let tgtNeighbors = adj.get(rel.targetId);
      if (!tgtNeighbors) {
        tgtNeighbors = [];
        adj.set(rel.targetId, tgtNeighbors);
      }
      tgtNeighbors.push(rel.sourceId);
    }

    // Aggregate for this edge type
    const typeEmbeds = new Map<string, number[]>();
    const dims = embeddings.values().next().value?.length ?? 0;
    if (dims === 0) continue;

    for (const [nodeId] of embeddings) {
      const neighbors = adj.get(nodeId) ?? [];
      const mean: number[] = new Array(dims).fill(0);
      let count = 0;
      for (const nid of neighbors) {
        const nvec = embeddings.get(nid);
        if (!nvec) continue;
        for (let i = 0; i < dims; i++) {
          mean[i] += nvec[i];
        }
        count++;
      }
      if (count > 0) {
        for (let i = 0; i < dims; i++) {
          mean[i] /= count;
        }
      }
      typeEmbeds.set(nodeId, mean);
    }
    result.set(edgeType, typeEmbeds);
  }

  return result;
}

// ── createSemanticEdges ────────────────────────────────────────────────────

/**
 * Create SEMANTICALLY_SIMILAR edges between nodes whose embedding cosine
 * similarity exceeds the threshold.
 *
 * These are virtual edges added to the graph — they do NOT correspond to
 * explicit code relationships but represent discovered semantic similarity.
 *
 * Each edge has:
 *   - type: SEMANTICALLY_SIMILAR
 *   - confidence: the cosine similarity score
 *   - reason: descriptive text
 *
 * To avoid O(N²) explosion, this implementation uses a sampling approach
 * for large graphs: each node is compared against the top-K most similar
 * candidates using a bucket-based pre-filter.
 *
 * @param graph        Knowledge graph to enrich (mutated in place).
 * @param embeddings   Node embeddings.
 * @param threshold    Cosine similarity threshold (default: 0.85).
 * @returns            Count and metadata about edges added.
 */
export function createSemanticEdges(
  graph: KnowledgeGraph,
  embeddings: Map<string, number[]>,
  threshold: number = 0.85,
): SemanticEdgeResult {
  const nodeIds = Array.from(embeddings.keys());
  const vecs = Array.from(embeddings.values());
  const n = nodeIds.length;

  if (n < 2) {
    return { edgesAdded: 0, threshold, provider: 'unknown', nodeCount: n };
  }

  // Build dimension-bucketed index for O(N * K) rather than O(N²) comparison
  // Each dimension becomes a bucket; nodes are grouped by max-value dimension
  const dims = vecs[0].length;
  const buckets: Array<Array<{ idx: number; nodeId: string }>> = new Array(dims);
  for (let d = 0; d < dims; d++) buckets[d] = [];

  for (let i = 0; i < n; i++) {
    const vec = vecs[i];
    let maxDim = 0;
    let maxVal = vec[0];
    for (let d = 1; d < dims; d++) {
      if (vec[d] > maxVal) {
        maxVal = vec[d];
        maxDim = d;
      }
    }
    buckets[maxDim].push({ idx: i, nodeId: nodeIds[i] });
  }

  // For each node, compare within its own bucket + top-connected buckets
  let edgesAdded = 0;

  // Track existing edges to avoid duplicates
  const existingEdges = new Set<string>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'SEMANTICALLY_SIMILAR') {
      existingEdges.add(`${rel.sourceId}|${rel.targetId}`);
    }
  }

  for (let i = 0; i < n; i++) {
    const vecA = vecs[i];
    const idA = nodeIds[i];

    // Find candidate nodes from the same dimension bucket
    const maxDim = buckets.findIndex((b) => b.some((e) => e.nodeId === idA));
    const candidates = new Set<number>();

    // Same bucket
    if (maxDim >= 0) {
      for (const entry of buckets[maxDim]) {
        if (entry.idx !== i) candidates.add(entry.idx);
      }
    }

    // Adjacent buckets (dim + 1, dim - 1)
    if (maxDim >= 0) {
      const prev = (maxDim - 1 + dims) % dims;
      const next = (maxDim + 1) % dims;
      for (const entry of buckets[prev]) candidates.add(entry.idx);
      for (const entry of buckets[next]) candidates.add(entry.idx);
    }

    // If bucket filter is too sparse, fall back to random sampling
    if (candidates.size < 5 && n <= 5000) {
      // Small graph — compare against all nodes
      for (let j = i + 1; j < n; j++) candidates.add(j);
    }

    for (const j of candidates) {
      if (j <= i && n <= 5000) continue; // Already compared in small-graph mode
      const vecB = vecs[j];
      const idB = nodeIds[j];

      // Skip if edge already exists
      const edgeKey = `${idA}|${idB}`;
      const edgeKeyRev = `${idB}|${idA}`;
      if (existingEdges.has(edgeKey) || existingEdges.has(edgeKeyRev)) continue;

      const similarity = cosineSimilarity(vecA, vecB);
      if (similarity >= threshold) {
        const edgeId = `semantic:${idA}:${idB}`;
        graph.addRelationship({
          id: edgeId,
          sourceId: idA,
          targetId: idB,
          type: 'SEMANTICALLY_SIMILAR',
          confidence: similarity,
          reason: `Cosine similarity ${similarity.toFixed(4)} above threshold ${threshold}`,
        });
        existingEdges.add(edgeKey);
        edgesAdded++;
      }
    }
  }

  return {
    edgesAdded,
    threshold,
    provider: 'built-in',
    nodeCount: n,
  };
}
