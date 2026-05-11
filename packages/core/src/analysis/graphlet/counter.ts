/**
 * Graphlet Analysis — Motif counting and architectural pattern detection (#461).
 *
 * Counts 3-node and 4-node graphlet motifs in the dependency graph
 * to reveal structural patterns like hub-and-spoke, chains, diamonds, cycles.
 */

// #461: Graphlet profile — result of counting motifs in a dependency graph
export interface GraphletProfile {
  /** 3-node motif counts */
  motif3: {
    /** Disconnected triples — no edges among 3 nodes */
    empty: number;
    /** Single edge — exactly one edge among 3 nodes */
    oneEdge: number;
    /** Path / v-shape — exactly 2 edges forming a path A-B-C */
    twoEdge: number;
    /** Fully connected triangle — all 3 edges present */
    triangle: number;
  };
  /** 4-node motif counts (key patterns only) */
  motif4: {
    /** Path of 4: A-B-C-D (linear chain) */
    chain: number;
    /** Hub with 3 leaves: one center connected to all others */
    star: number;
    /** A→B, A→C, B→D, C→D (convergent-divergent pattern) */
    diamond: number;
    /** 4-node cycle: A-B-C-D-A */
    cycle: number;
    /** Fully connected 4 nodes (6 edges) */
    clique: number;
  };
  /** Total nodes and edges analyzed */
  nodeCount: number;
  edgeCount: number;
  /** Sampling metadata */
  sampled: boolean;
  sampleSize?: number;
}

// #461: Constants for sampling thresholds
const FULL_ENUMERATION_THRESHOLD = 1000;
const DEFAULT_SAMPLE_SIZE = 500;

/**
 * Count graphlet motifs in a dependency graph.
 *
 * For graphs ≤ 1000 nodes: enumerates all 3-node and 4-node subgraphs
 * via neighborhood sampling of every node.
 * For graphs > 1000 nodes: samples up to 500 random nodes and counts
 * motifs in their 2-hop neighborhoods.
 *
 * @param nodes  Iterable of node objects with an `id` field
 * @param adjMap Adjacency map: node ID → set of neighbor IDs (undirected)
 * @param maxNodes Optional override for the sampling threshold
 */
// #461: Main graphlet counting entry point
export function countGraphlets(
  nodes: Iterable<{ id: string }>,
  adjMap: Map<string, Set<string>>,
  maxNodes?: number,
): GraphletProfile {
  const threshold = maxNodes ?? FULL_ENUMERATION_THRESHOLD;

  // Collect all node IDs
  const allNodeIds: string[] = [];
  for (const node of nodes) {
    allNodeIds.push(node.id);
  }

  const totalNodes = allNodeIds.length;

  // Edge case: empty or trivial graph
  if (totalNodes === 0) {
    return emptyProfile(0, 0, false);
  }

  // Count total edges
  let totalEdges = 0;
  for (const [, neighbors] of adjMap) {
    totalEdges += neighbors.size;
  }
  totalEdges = Math.floor(totalEdges / 2); // undirected, each edge counted twice

  if (totalNodes < 3) {
    return emptyProfile(totalNodes, totalEdges, false);
  }

  // Decide whether to sample
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

  // Initialize counts
  let empty = 0;
  let oneEdge = 0;
  let twoEdge = 0;
  let triangle = 0;
  let chain4 = 0;
  let star = 0;
  let diamond = 0;
  let cycle = 0;
  let clique = 0;

  // #461: 3-node motif counting
  // For each node A, for each pair of neighbors (B, C), check edges among them.
  // We use a set to avoid counting the same triple multiple times.
  const counted3 = new Set<string>();

  for (const nodeId of sampledNodeIds) {
    const neighbors = adjMap.get(nodeId);
    if (!neighbors || neighbors.size < 2) continue;

    const neighborArr = Array.from(neighbors);
    for (let i = 0; i < neighborArr.length; i++) {
      for (let j = i + 1; j < neighborArr.length; j++) {
        const b = neighborArr[i];
        const c = neighborArr[j];
        const key = sort3(nodeId, b, c);
        if (counted3.has(key)) continue;
        counted3.add(key);

        // Count edges among the 3 nodes
        const edgeAB = neighborsOf(b, adjMap).has(nodeId);
        const edgeAC = neighborsOf(c, adjMap).has(nodeId);
        const edgeBC = neighborsOf(b, adjMap).has(c);

        // In an undirected adjacency map, A-B and A-C are guaranteed
        // since we're iterating A's neighbors. So edge count is at least 2
        // from A's perspective. But we classify by total edges:
        const edges = (edgeAB ? 1 : 0) + (edgeAC ? 1 : 0) + (edgeBC ? 1 : 0);

        switch (edges) {
          case 0: empty++; break;
          case 1: oneEdge++; break;
          case 2: twoEdge++; break;
          case 3: triangle++; break;
        }
      }
    }
  }

  // Also count triples where nodeId is NOT connected to both others
  // (empty and 1-edge triples where node is not the center).
  // For efficiency, sample additional random triples.
  if (totalNodes >= 3) {
    // #461: Count disconnected and single-edge triples via random sampling
    const tripleSamples = Math.min(5000, totalNodes * 3);
    for (let s = 0; s < tripleSamples; s++) {
      const a = allNodeIds[Math.floor(pseudoRandom(s) * totalNodes)];
      const b = allNodeIds[Math.floor(pseudoRandom(s + 1000) * totalNodes)];
      const c = allNodeIds[Math.floor(pseudoRandom(s + 2000) * totalNodes)];
      if (a === b || b === c || a === c) continue;

      const key = sort3(a, b, c);
      if (counted3.has(key)) continue;
      counted3.add(key);

      const eAB = neighborsOf(a, adjMap).has(b);
      const eAC = neighborsOf(a, adjMap).has(c);
      const eBC = neighborsOf(b, adjMap).has(c);
      const edges = (eAB ? 1 : 0) + (eAC ? 1 : 0) + (eBC ? 1 : 0);

      switch (edges) {
        case 0: empty++; break;
        case 1: oneEdge++; break;
        case 2: twoEdge++; break;
        case 3: triangle++; break;
      }
    }
  }

  // #461: 4-node motif counting
  // For each node A, for each triple of neighbors (B, C, D),
  // count edges among them to classify the 4-node motif.
  const counted4 = new Set<string>();

  for (const nodeId of sampledNodeIds) {
    const neighbors = adjMap.get(nodeId);
    if (!neighbors || neighbors.size < 3) continue;

    const neighborArr = Array.from(neighbors);
    // Limit neighbor combinations for performance
    const maxNeighborIdx = Math.min(neighborArr.length, 30);

    for (let i = 0; i < maxNeighborIdx; i++) {
      for (let j = i + 1; j < maxNeighborIdx; j++) {
        for (let k = j + 1; k < maxNeighborIdx; k++) {
          const b = neighborArr[i];
          const c = neighborArr[j];
          const d = neighborArr[k];
          const key = sort4(nodeId, b, c, d);
          if (counted4.has(key)) continue;
          counted4.add(key);

          // Count all 6 possible edges among 4 nodes
          const nA = neighborsOf(nodeId, adjMap);
          const nB = neighborsOf(b, adjMap);
          const nC = neighborsOf(c, adjMap);
          const nD = neighborsOf(d, adjMap);

          let edges = 0;
          if (nA.has(b)) edges++;
          if (nA.has(c)) edges++;
          if (nA.has(d)) edges++;
          if (nB.has(c)) edges++;
          if (nB.has(d)) edges++;
          if (nC.has(d)) edges++;

          // Classify 4-node graphlet by edge count and structure
          if (edges === 6) {
            clique++;
          } else if (edges === 5) {
            // Near-clique, classify as diamond variant
            diamond++;
          } else if (edges === 4) {
            // Could be diamond (4 edges, no direct edge between two opposite nodes)
            // or cycle (4-cycle has exactly 4 edges)
            // Check if it's a cycle: each node has degree 2 in the subgraph
            const degA = (nA.has(b) ? 1 : 0) + (nA.has(c) ? 1 : 0) + (nA.has(d) ? 1 : 0);
            const degB = (nB.has(nodeId) ? 1 : 0) + (nB.has(c) ? 1 : 0) + (nB.has(d) ? 1 : 0);
            const degC = (nC.has(nodeId) ? 1 : 0) + (nC.has(b) ? 1 : 0) + (nC.has(d) ? 1 : 0);
            const degD = (nD.has(nodeId) ? 1 : 0) + (nD.has(b) ? 1 : 0) + (nD.has(c) ? 1 : 0);

            if (degA === 2 && degB === 2 && degC === 2 && degD === 2) {
              cycle++;
            } else {
              diamond++;
            }
          } else if (edges === 3) {
            // Could be star (one center with degree 3) or chain variant
            const degA = (nA.has(b) ? 1 : 0) + (nA.has(c) ? 1 : 0) + (nA.has(d) ? 1 : 0);
            if (degA === 3) {
              star++;
            } else {
              // Check if any node has degree 3
              const degB2 = (nB.has(nodeId) ? 1 : 0) + (nB.has(c) ? 1 : 0) + (nB.has(d) ? 1 : 0);
              const degC2 = (nC.has(nodeId) ? 1 : 0) + (nC.has(b) ? 1 : 0) + (nC.has(d) ? 1 : 0);
              const degD2 = (nD.has(nodeId) ? 1 : 0) + (nD.has(b) ? 1 : 0) + (nD.has(c) ? 1 : 0);
              if (degB2 === 3 || degC2 === 3 || degD2 === 3) {
                star++;
              } else {
                chain4++;
              }
            }
          } else if (edges === 2) {
            chain4++;
          }
          // edges <= 1: not meaningful for architectural patterns, skip
        }
      }
    }
  }

  return {
    motif3: { empty, oneEdge, twoEdge, triangle },
    motif4: { chain: chain4, star, diamond, cycle, clique },
    nodeCount: totalNodes,
    edgeCount: totalEdges,
    sampled,
    sampleSize,
  };
}

// #461: Build an undirected adjacency map from graph edges.
// Only includes CALLS, IMPORTS, EXTENDS edge types.
export function buildAdjacencyMap(
  relationships: Iterable<{ sourceId: string; targetId: string; type: string }>,
  nodeIds: Set<string>,
): Map<string, Set<string>> {
  const adjMap = new Map<string, Set<string>>();
  const allowedTypes = new Set(['CALLS', 'IMPORTS', 'EXTENDS']);

  // Initialize all nodes
  for (const id of nodeIds) {
    adjMap.set(id, new Set());
  }

  for (const rel of relationships) {
    if (!allowedTypes.has(rel.type)) continue;
    if (!nodeIds.has(rel.sourceId) || !nodeIds.has(rel.targetId)) continue;

    // Add undirected edge
    let srcSet = adjMap.get(rel.sourceId);
    if (!srcSet) { srcSet = new Set(); adjMap.set(rel.sourceId, srcSet); }
    srcSet.add(rel.targetId);

    let tgtSet = adjMap.get(rel.targetId);
    if (!tgtSet) { tgtSet = new Set(); adjMap.set(rel.targetId, tgtSet); }
    tgtSet.add(rel.sourceId);
  }

  return adjMap;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// #461: Get neighbors of a node, safely returning empty set if not found
function neighborsOf(nodeId: string, adjMap: Map<string, Set<string>>): Set<string> {
  return adjMap.get(nodeId) ?? new Set();
}

// #461: Create a canonical key for a 3-node subgraph
function sort3(a: string, b: string, c: string): string {
  const arr = [a, b, c].sort();
  return `${arr[0]}:${arr[1]}:${arr[2]}`;
}

// #461: Create a canonical key for a 4-node subgraph
function sort4(a: string, b: string, c: string, d: string): string {
  const arr = [a, b, c, d].sort();
  return `${arr[0]}:${arr[1]}:${arr[2]}:${arr[3]}`;
}

// #461: Deterministic pseudo-random for reproducible sampling
function pseudoRandom(seed: number): number {
  let x = Math.sin(seed * 9301 + 49297) * 49297;
  return x - Math.floor(x);
}

// #461: Random sample of array elements
function randomSample<T>(arr: T[], size: number): T[] {
  const shuffled = arr.slice();
  // Fisher-Yates shuffle (partial)
  for (let i = 0; i < Math.min(size, shuffled.length); i++) {
    const j = i + Math.floor(pseudoRandom(i) * (shuffled.length - i));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, size);
}

// #461: Empty profile for edge cases
function emptyProfile(nodeCount: number, edgeCount: number, sampled: boolean): GraphletProfile {
  return {
    motif3: { empty: 0, oneEdge: 0, twoEdge: 0, triangle: 0 },
    motif4: { chain: 0, star: 0, diamond: 0, cycle: 0, clique: 0 },
    nodeCount,
    edgeCount,
    sampled,
  };
}
