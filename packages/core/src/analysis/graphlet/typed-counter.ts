/**
 * Graphlet Analysis — Typed motif counting with node labels and edge types (#872).
 *
 * Extends the untyped graphlet counter (#461) by considering node labels
 * (Class, Function, Method, …) and relationship types (CALLS, IMPORTS, …)
 * when counting 3-node and 4-node motifs. This enables semantic pattern
 * detection such as "Class-CALLS-Function-CALLS-Class triangles" vs
 * "Class-EXTENDS-Class-IMPLEMENTS-Interface diamonds".
 */

import type { GraphNode, GraphRelationship } from '@astrolabe-dev/shared';

// #872: Relationship types considered by the typed counter.
// Broader than the untyped counter (CALLS, IMPORTS, EXTENDS) to capture
// richer semantic patterns.
const TYPED_ALLOWED_REL_TYPES: ReadonlySet<string> = new Set([
  'CALLS',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'USES',
  'MEMBER_OF',
  'HAS_METHOD',
  'HAS_PROPERTY',
]);

// #872: Sampling thresholds — same strategy as untyped counter (#461)
const FULL_ENUMERATION_THRESHOLD = 1000;
const DEFAULT_SAMPLE_SIZE = 500;

// ── Exported types ────────────────────────────────────────────────────────────

/**
 * Typed adjacency map: nodeId → (neighborId → relationshipType).
 *
 * Stores the relationship type for every undirected edge. If multiple
 * relationship types exist between the same pair, only one is kept
 * (first encountered wins during construction).
 */
export type TypedAdjacencyMap = Map<string, Map<string, string>>;

/**
 * Branded string key encoding a typed motif signature.
 *
 * For a single edge:   `"SourceLabel-REL_TYPE-TargetLabel"`
 * For a 3-node motif:  `"LabelA:LabelB:LabelC"` with edge types encoded
 *                       as `"RelAB-RelAC-RelBC"`
 * For a 4-node motif:  `"LabelA:LabelB:LabelC:LabelD"` with edge types encoded
 *                       as `"RelAB-RelAC-RelAD-RelBC-RelBD-RelCD"`
 */
export type TypedMotifKey = string & { readonly __brand: unique symbol };

/**
 * Typed graphlet profile — same shape as GraphletProfile but each motif
 * class is further broken down by node-label and edge-type combinations.
 */
export interface TypedGraphletProfile {
  /** 3-node motif counts keyed by TypedMotifKey (label triplet + edge types) */
  motif3: Map<TypedMotifKey, number>;
  /** 4-node motif counts keyed by TypedMotifKey (label quartet + edge types) */
  motif4: Map<TypedMotifKey, number>;
  /** Total nodes and edges analyzed */
  nodeCount: number;
  edgeCount: number;
  /** Sampling metadata */
  sampled: boolean;
  sampleSize?: number;
}

// ── Build typed adjacency ────────────────────────────────────────────────────

/**
 * Build a typed adjacency map and node label lookup from raw graph data.
 *
 * Returns:
 * - `nodeLabels`: nodeId → label string
 * - `typedAdj`: nodeId → (neighborId → relationshipType)
 *
 * Only edges with allowed relationship types are included. Edges are stored
 * undirected — both directions are populated with the same type.
 */
// #872: Build typed adjacency from GraphNode[] and GraphRelationship[]
export function buildTypedAdjacencyMap(
  nodes: readonly GraphNode[],
  relationships: readonly GraphRelationship[],
): {
  nodeLabels: Map<string, string>;
  typedAdj: TypedAdjacencyMap;
} {
  const nodeLabels = new Map<string, string>();
  const typedAdj: TypedAdjacencyMap = new Map();

  // Register all nodes
  for (const node of nodes) {
    nodeLabels.set(node.id, node.label);
    typedAdj.set(node.id, new Map());
  }

  // Add undirected typed edges
  for (const rel of relationships) {
    if (!TYPED_ALLOWED_REL_TYPES.has(rel.type)) continue;
    if (!nodeLabels.has(rel.sourceId) || !nodeLabels.has(rel.targetId)) continue;

    const srcMap = typedAdj.get(rel.sourceId);
    const tgtMap = typedAdj.get(rel.targetId);
    if (!srcMap || !tgtMap) continue;

    // Only store first encountered type per edge pair
    if (!srcMap.has(rel.targetId)) {
      srcMap.set(rel.targetId, rel.type);
    }
    if (!tgtMap.has(rel.sourceId)) {
      tgtMap.set(rel.sourceId, rel.type);
    }
  }

  return { nodeLabels, typedAdj };
}

// ── Typed graphlet counting ──────────────────────────────────────────────────

/**
 * Count typed graphlet motifs in a dependency graph.
 *
 * For graphs ≤ 1000 nodes: enumerates all 3-node and 4-node subgraphs.
 * For graphs > 1000 nodes: samples up to 500 random nodes.
 *
 * Each motif is classified by:
 * 1. The sorted label triplet/quartet (e.g. "Class:Function:Method")
 * 2. The edge type combination (e.g. "CALLS-IMPORTS-EXTENDS")
 *
 * Both parts are combined into a single TypedMotifKey.
 *
 * @param nodes      Graph nodes (must have `id` and `label`)
 * @param typedAdj   Typed adjacency map from `buildTypedAdjacencyMap`
 * @param nodeLabels Node label lookup from `buildTypedAdjacencyMap`
 * @param maxNodes   Optional override for the sampling threshold
 */
// #872: Main typed graphlet counting entry point
export function countTypedGraphlets(
  nodes: Iterable<GraphNode>,
  typedAdj: TypedAdjacencyMap,
  nodeLabels: Map<string, string>,
  maxNodes?: number,
): TypedGraphletProfile {
  const threshold = maxNodes ?? FULL_ENUMERATION_THRESHOLD;

  // Collect node IDs
  const allNodeIds: string[] = [];
  for (const node of nodes) {
    allNodeIds.push(node.id);
  }

  const totalNodes = allNodeIds.length;

  if (totalNodes === 0) {
    return emptyTypedProfile(0, 0, false);
  }

  // Count total edges (each undirected edge stored twice)
  let totalEdges = 0;
  for (const [, neighbors] of typedAdj) {
    totalEdges += neighbors.size;
  }
  totalEdges = Math.floor(totalEdges / 2);

  if (totalNodes < 3) {
    return emptyTypedProfile(totalNodes, totalEdges, false);
  }

  // Decide sampling strategy
  let sampledNodeIds: string[];
  let sampled = false;
  let sampleSize: number | undefined;

  if (totalNodes > threshold) {
    sampledNodeIds = randomSample(allNodeIds, DEFAULT_SAMPLE_SIZE);
    sampled = true;
    sampleSize = sampledNodeIds.length;
  } else {
    sampledNodeIds = allNodeIds;
  }

  // Motif counters
  const motif3 = new Map<TypedMotifKey, number>();
  const motif4 = new Map<TypedMotifKey, number>();

  // #872: 3-node typed motif counting
  const counted3 = new Set<string>();

  for (const nodeId of sampledNodeIds) {
    const neighbors = typedAdj.get(nodeId);
    if (!neighbors || neighbors.size < 2) continue;

    const neighborArr = Array.from(neighbors.keys());
    for (let i = 0; i < neighborArr.length; i++) {
      for (let j = i + 1; j < neighborArr.length; j++) {
        const b = neighborArr[i];
        const c = neighborArr[j];
        const key = sort3(nodeId, b, c);
        if (counted3.has(key)) continue;
        counted3.add(key);

        // Check edges among the 3 nodes
        const nA = typedAdj.get(nodeId);
        const nB = typedAdj.get(b);
        const nC = typedAdj.get(c);
        if (!nA || !nB || !nC) continue;

        const hasAB = nA.has(b);
        const hasAC = nA.has(c);
        const hasBC = nB.has(c);

        if (!hasAB && !hasAC) continue; // nodeId not connected to either → skip (handled below)

        const motifKey = buildTypedMotifKey3(
          nodeId, b, c,
          hasAB ? nA.get(b)! : '',
          hasAC ? nA.get(c)! : '',
          hasBC ? nB.get(c)! : '',
          nodeLabels,
        );

        incrementMap(motif3, motifKey);
      }
    }
  }

  // Count disconnected and single-edge triples via random sampling
  if (totalNodes >= 3) {
    const tripleSamples = Math.min(5000, totalNodes * 3);
    for (let s = 0; s < tripleSamples; s++) {
      const a = allNodeIds[Math.floor(pseudoRandom(s) * totalNodes)];
      const b = allNodeIds[Math.floor(pseudoRandom(s + 1000) * totalNodes)];
      const c = allNodeIds[Math.floor(pseudoRandom(s + 2000) * totalNodes)];
      if (a === b || b === c || a === c) continue;

      const key = sort3(a, b, c);
      if (counted3.has(key)) continue;
      counted3.add(key);

      const nA = typedAdj.get(a);
      const nB = typedAdj.get(b);
      const nC = typedAdj.get(c);
      if (!nA || !nB || !nC) continue;

      const hasAB = nA.has(b);
      const hasAC = nA.has(c);
      const hasBC = nB.has(c);
      const edgeCount = (hasAB ? 1 : 0) + (hasAC ? 1 : 0) + (hasBC ? 1 : 0);

      // Only count lower-edge motifs here (higher ones already counted)
      if (edgeCount < 2) {
        const motifKey = buildTypedMotifKey3(
          a, b, c,
          hasAB ? nA.get(b)! : '',
          hasAC ? nA.get(c)! : '',
          hasBC ? nB.get(c)! : '',
          nodeLabels,
        );
        incrementMap(motif3, motifKey);
      }
    }
  }

  // #872: 4-node typed motif counting
  const counted4 = new Set<string>();

  for (const nodeId of sampledNodeIds) {
    const neighbors = typedAdj.get(nodeId);
    if (!neighbors || neighbors.size < 3) continue;

    const neighborArr = Array.from(neighbors.keys());
    const maxIdx = Math.min(neighborArr.length, 30);

    for (let i = 0; i < maxIdx; i++) {
      for (let j = i + 1; j < maxIdx; j++) {
        for (let k = j + 1; k < maxIdx; k++) {
          const b = neighborArr[i];
          const c = neighborArr[j];
          const d = neighborArr[k];
          const key = sort4(nodeId, b, c, d);
          if (counted4.has(key)) continue;
          counted4.add(key);

          const nA = typedAdj.get(nodeId);
          const nB = typedAdj.get(b);
          const nC = typedAdj.get(c);
          const nD = typedAdj.get(d);
          if (!nA || !nB || !nC || !nD) continue;

          // Count all 6 possible edges
          let edges = 0;
          const hasAB = nA.has(b); if (hasAB) edges++;
          const hasAC = nA.has(c); if (hasAC) edges++;
          const hasAD = nA.has(d); if (hasAD) edges++;
          const hasBC = nB.has(c); if (hasBC) edges++;
          const hasBD = nB.has(d); if (hasBD) edges++;
          const hasCD = nC.has(d); if (hasCD) edges++;

          if (edges <= 1) continue; // not meaningful for architectural patterns

          // Determine 4-node motif shape
          const shape = classify4NodeMotif(
            hasAB, hasAC, hasAD, hasBC, hasBD, hasCD,
            nA, nB, nC, nD,
            nodeId, b, c, d,
          );

          if (shape === null) continue;

          const motifKey = buildTypedMotifKey4(
            nodeId, b, c, d,
            hasAB ? nA.get(b)! : '',
            hasAC ? nA.get(c)! : '',
            hasAD ? nA.get(d)! : '',
            hasBC ? nB.get(c)! : '',
            hasBD ? nB.get(d)! : '',
            hasCD ? nC.get(d)! : '',
            nodeLabels,
            shape,
          );

          incrementMap(motif4, motifKey);
        }
      }
    }
  }

  return {
    motif3,
    motif4,
    nodeCount: totalNodes,
    edgeCount: totalEdges,
    sampled,
    sampleSize,
  };
}

/**
 * Create an empty typed graphlet profile for edge cases.
 */
// #872: Empty typed profile helper
export function emptyTypedProfile(
  nodeCount: number,
  edgeCount: number,
  sampled: boolean,
): TypedGraphletProfile {
  return {
    motif3: new Map(),
    motif4: new Map(),
    nodeCount,
    edgeCount,
    sampled,
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

// #872: Build a typed motif key for a 3-node subgraph
function buildTypedMotifKey3(
  a: string,
  b: string,
  c: string,
  relAB: string,
  relAC: string,
  relBC: string,
  nodeLabels: Map<string, string>,
): TypedMotifKey {
  const labelA = nodeLabels.get(a) ?? 'Unknown';
  const labelB = nodeLabels.get(b) ?? 'Unknown';
  const labelC = nodeLabels.get(c) ?? 'Unknown';

  // Sort labels alphabetically for canonical form
  const labels = [labelA, labelB, labelC].sort();
  const labelKey = labels.join(':');

  // Sort non-empty edge types for canonical form
  const edgeTypes = [relAB, relAC, relBC].filter(t => t !== '').sort();
  const edgeKey = edgeTypes.join('-');

  return `${labelKey}|${edgeKey}` as TypedMotifKey;
}

// #872: Build a typed motif key for a 4-node subgraph
function buildTypedMotifKey4(
  a: string,
  b: string,
  c: string,
  d: string,
  relAB: string,
  relAC: string,
  relAD: string,
  relBC: string,
  relBD: string,
  relCD: string,
  nodeLabels: Map<string, string>,
  shape: string,
): TypedMotifKey {
  const labelA = nodeLabels.get(a) ?? 'Unknown';
  const labelB = nodeLabels.get(b) ?? 'Unknown';
  const labelC = nodeLabels.get(c) ?? 'Unknown';
  const labelD = nodeLabels.get(d) ?? 'Unknown';

  const labels = [labelA, labelB, labelC, labelD].sort();
  const labelKey = labels.join(':');

  const edgeTypes = [relAB, relAC, relAD, relBC, relBD, relCD]
    .filter(t => t !== '')
    .sort();
  const edgeKey = edgeTypes.join('-');

  return `${shape}|${labelKey}|${edgeKey}` as TypedMotifKey;
}

// #872: Classify a 4-node motif shape by edge count and degree pattern
type NeighborMap = Map<string, string>;

function classify4NodeMotif(
  hasAB: boolean, hasAC: boolean, hasAD: boolean,
  hasBC: boolean, hasBD: boolean, hasCD: boolean,
  _nA: NeighborMap, _nB: NeighborMap, _nC: NeighborMap, _nD: NeighborMap,
  _idA: string, _idB: string, _idC: string, _idD: string,
): string | null {
  const edges = (hasAB ? 1 : 0) + (hasAC ? 1 : 0) + (hasAD ? 1 : 0)
    + (hasBC ? 1 : 0) + (hasBD ? 1 : 0) + (hasCD ? 1 : 0);

  if (edges === 6) return 'clique';
  if (edges === 5) return 'diamond'; // near-clique variant

  if (edges === 4) {
    // Check if it's a 4-cycle: each node has degree 2 in the subgraph
    const degA = (hasAB ? 1 : 0) + (hasAC ? 1 : 0) + (hasAD ? 1 : 0);
    const degB = (hasAB ? 1 : 0) + (hasBC ? 1 : 0) + (hasBD ? 1 : 0);
    const degC = (hasAC ? 1 : 0) + (hasBC ? 1 : 0) + (hasCD ? 1 : 0);
    const degD = (hasAD ? 1 : 0) + (hasBD ? 1 : 0) + (hasCD ? 1 : 0);

    if (degA === 2 && degB === 2 && degC === 2 && degD === 2) {
      return 'cycle';
    }
    return 'diamond';
  }

  if (edges === 3) {
    const degA = (hasAB ? 1 : 0) + (hasAC ? 1 : 0) + (hasAD ? 1 : 0);
    const degB = (hasAB ? 1 : 0) + (hasBC ? 1 : 0) + (hasBD ? 1 : 0);
    const degC = (hasAC ? 1 : 0) + (hasBC ? 1 : 0) + (hasCD ? 1 : 0);
    const degD = (hasAD ? 1 : 0) + (hasBD ? 1 : 0) + (hasCD ? 1 : 0);

    if (degA === 3 || degB === 3 || degC === 3 || degD === 3) {
      return 'star';
    }
    return 'chain';
  }

  if (edges === 2) {
    return 'chain';
  }

  return null; // 0 or 1 edges — not meaningful
}

// #872: Increment a counter in a Map<TypedMotifKey, number>
function incrementMap(
  map: Map<TypedMotifKey, number>,
  key: TypedMotifKey,
): void {
  const current = map.get(key);
  map.set(key, (current ?? 0) + 1);
}

// #872: Create a canonical key for a 3-node subgraph
function sort3(a: string, b: string, c: string): string {
  const arr = [a, b, c].sort();
  return `${arr[0]}:${arr[1]}:${arr[2]}`;
}

// #872: Create a canonical key for a 4-node subgraph
function sort4(a: string, b: string, c: string, d: string): string {
  const arr = [a, b, c, d].sort();
  return `${arr[0]}:${arr[1]}:${arr[2]}:${arr[3]}`;
}

// #872: Deterministic pseudo-random for reproducible sampling
function pseudoRandom(seed: number): number {
  let x = Math.sin(seed * 9301 + 49297) * 49297;
  return x - Math.floor(x);
}

// #872: Random sample of array elements (Fisher-Yates partial shuffle)
function randomSample<T>(arr: T[], size: number): T[] {
  const shuffled = arr.slice();
  for (let i = 0; i < Math.min(size, shuffled.length); i++) {
    const j = i + Math.floor(pseudoRandom(i) * (shuffled.length - i));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, size);
}
