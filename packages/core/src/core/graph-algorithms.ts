/**
 * Graph algorithms for architecture analysis.
 *
 * PageRank, betweenness centrality, and shortest-path on the dependency
 * adjacency list derived from CALLS / IMPORTS edges.
 */

export interface GraphAlgorithmResult {
  nodeId: string;
  score: number;
}

// ── PageRank ────────────────────────────────────────────────────────────────

/** Iterative PageRank on a directed adjacency list. */
export function pageRank(
  adjList: Map<string, string[]>,
  options?: { damping?: number; iterations?: number; tolerance?: number },
): GraphAlgorithmResult[] {
  const damping = options?.damping ?? 0.85;
  const maxIterations = options?.iterations ?? 100;
  const tolerance = options?.tolerance ?? 1e-6;

  const nodes = Array.from(adjList.keys());
  const n = nodes.length;
  if (n === 0) return [];

  // Build reverse adjacency (who points TO each node) for fast lookup
  const reverseAdj = new Map<string, string[]>();
  for (const node of nodes) {
    reverseAdj.set(node, []);
  }
  for (const [src, targets] of adjList) {
    for (const tgt of targets) {
      // Ensure target exists in reverse map (may not be a key in adjList)
      let bucket = reverseAdj.get(tgt);
      if (!bucket) {
        bucket = [];
        reverseAdj.set(tgt, bucket);
      }
      bucket.push(src);
    }
  }

  // Out-degree for each node
  const outDegree = new Map<string, number>();
  for (const node of nodes) {
    outDegree.set(node, adjList.get(node)?.length ?? 0);
  }

  // Identify dangling nodes (no outgoing edges)
  const danglingNodes = nodes.filter((node) => (outDegree.get(node) ?? 0) === 0);

  // Initialise scores uniformly
  let scores = new Map<string, number>();
  for (const node of nodes) {
    scores.set(node, 1 / n);
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    // Dangling node contribution (redistributed uniformly)
    const danglingSum = danglingNodes.reduce((sum, node) => sum + (scores.get(node) ?? 0), 0);

    const nextScores = new Map<string, number>();

    for (const node of nodes) {
      const inLinks = reverseAdj.get(node) ?? [];
      let rank = (1 - damping) / n;
      rank += damping * danglingSum / n;

      for (const src of inLinks) {
        const srcDegree = outDegree.get(src) ?? 1;
        rank += damping * (scores.get(src) ?? 0) / srcDegree;
      }

      nextScores.set(node, rank);
    }

    // Check convergence
    let diff = 0;
    for (const node of nodes) {
      diff += Math.abs((nextScores.get(node) ?? 0) - (scores.get(node) ?? 0));
    }
    scores = nextScores;

    if (diff < tolerance) break;
  }

  return nodes
    .map((nodeId) => ({ nodeId, score: scores.get(nodeId) ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

// ── Betweenness Centrality ──────────────────────────────────────────────────

/**
 * Simplified Brandes betweenness centrality for an undirected view of the
 * directed adjacency list.  Runs BFS from every node and counts the fraction
 * of shortest paths that pass through each intermediate node.
 */
export function betweennessCentrality(
  adjList: Map<string, string[]>,
): GraphAlgorithmResult[] {
  const nodes = Array.from(adjList.keys());
  if (nodes.length === 0) return [];

  const cb = new Map<string, number>();
  for (const node of nodes) cb.set(node, 0);

  // #465: Pre-build reverse adjacency list once (avoids O(N²) scan per BFS node)
  const reverseAdj = new Map<string, string[]>();
  for (const node of nodes) reverseAdj.set(node, []);
  for (const [u, targets] of adjList) {
    for (const v of targets) {
      const rev = reverseAdj.get(v);
      if (rev && !rev.includes(u)) rev.push(u);
    }
  }

  for (const source of nodes) {
    // BFS from source
    const stack: string[] = [];
    const predecessors = new Map<string, string[]>();
    const shortestPaths = new Map<string, number>();
    const distance = new Map<string, number>();

    for (const node of nodes) {
      predecessors.set(node, []);
      shortestPaths.set(node, 0);
      distance.set(node, -1);
    }
    shortestPaths.set(source, 1);
    distance.set(source, 0);

    const queue: string[] = [source];

    while (queue.length > 0) {
      const v = queue.shift()!;
      stack.push(v);

      const neighbors = adjList.get(v) ?? [];
      for (const w of neighbors) {
        // First visit of w
        if (distance.get(w) === -1) {
          distance.set(w, distance.get(v)! + 1);
          queue.push(w);
        }
        // Shortest path to w via v
        if (distance.get(w) === distance.get(v)! + 1) {
          shortestPaths.set(w, shortestPaths.get(w)! + shortestPaths.get(v)!);
          predecessors.get(w)!.push(v);
        }
      }

      // #465: Use pre-built reverse adjacency (O(1) per neighbor instead of O(N²))
      const reverseNeighbors = reverseAdj.get(v) ?? [];
      for (const w of reverseNeighbors) {
        if (neighbors.includes(w)) continue; // already handled as forward edge
        if (distance.get(w) === -1) {
          distance.set(w, distance.get(v)! + 1);
          queue.push(w);
        }
        if (distance.get(w) === distance.get(v)! + 1) {
          shortestPaths.set(w, shortestPaths.get(w)! + shortestPaths.get(v)!);
          predecessors.get(w)!.push(v);
        }
      }
    }

    // Back-propagation of dependency
    const delta = new Map<string, number>();
    for (const node of nodes) delta.set(node, 0);

    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of predecessors.get(w)!) {
        const contrib = (shortestPaths.get(v)! / shortestPaths.get(w)!) * (1 + delta.get(w)!);
        delta.set(v, delta.get(v)! + contrib);
      }
      if (w !== source) {
        cb.set(w, cb.get(w)! + delta.get(w)!);
      }
    }
  }

  // Normalise: undirected graph divides by 2
  for (const node of nodes) {
    cb.set(node, cb.get(node)! / 2);
  }

  return nodes
    .map((nodeId) => ({ nodeId, score: cb.get(nodeId) ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

// ── Shortest Path (BFS) ────────────────────────────────────────────────────

/**
 * BFS shortest path from source to target on an undirected view of the
 * directed adjacency list.  Returns the path as an array of node IDs or
 * `null` if no path exists.
 */
export function shortestPath(
  adjList: Map<string, string[]>,
  source: string,
  target: string,
): string[] | null {
  if (source === target) return [source];
  if (!adjList.has(source) && !hasTarget(adjList, source)) return null;
  if (!adjList.has(target) && !hasTarget(adjList, target)) return null;

  // Build undirected adjacency list
  const undirected = new Map<string, Set<string>>();
  for (const [node, neighbors] of adjList) {
    let set = undirected.get(node);
    if (!set) { set = new Set(); undirected.set(node, set); }
    for (const neighbor of neighbors) {
      set.add(neighbor);
      let neighborSet = undirected.get(neighbor);
      if (!neighborSet) { neighborSet = new Set(); undirected.set(neighbor, neighborSet); }
      neighborSet.add(node);
    }
  }

  const visited = new Set<string>([source]);
  const parent = new Map<string, string>();
  const queue: string[] = [source];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = undirected.get(current);

    if (neighbors) {
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        parent.set(neighbor, current);

        if (neighbor === target) {
          // Reconstruct path
          const path: string[] = [target];
          let node: string = target;
          while (parent.has(node)) {
            node = parent.get(node)!;
            path.push(node);
          }
          return path.reverse();
        }

        queue.push(neighbor);
      }
    }
  }

  return null;
}

/** Check if a node ID appears as a target in any adjacency list entry. */
function hasTarget(adjList: Map<string, string[]>, nodeId: string): boolean {
  for (const neighbors of adjList.values()) {
    if (neighbors.includes(nodeId)) return true;
  }
  return false;
}

// ── Spectral / Entropy Metrics (#812) ────────────────────────────────────────

export interface SpectralMetrics {
  nodeCount: number;
  edgeCount: number;
  density: number;
  degreeEntropy: number;
  avgDegree: number;
  maxDegree: number;
  flowHierarchy: number;
  modularityQ: number;
  topologyType: 'tree-like' | 'star-like' | 'mesh-like' | 'hybrid';
  topologyConfidence: number;
}

/**
 * Compute spectral graph metrics from a directed adjacency list.
 *
 * Metrics include density, degree entropy, flow hierarchy (via Kahn's
 * algorithm), optional Newman-Girvan modularity Q, and topology classification.
 *
 * @param adjList  Directed adjacency list (every node is a key)
 * @param communities  Optional community→members map for modularity Q
 */
export function computeSpectralMetrics(
  adjList: Map<string, string[]>,
  communities?: Map<string, string[]>,
): SpectralMetrics {
  const nodes = Array.from(adjList.keys());
  const nodeCount = nodes.length;

  // ── edgeCount ──────────────────────────────────────────────────────────
  let edgeCount = 0;
  for (const targets of adjList.values()) {
    edgeCount += targets.length;
  }

  // ── density ────────────────────────────────────────────────────────────
  const density =
    nodeCount > 1
      ? Math.min(1, edgeCount / (nodeCount * (nodeCount - 1)))
      : 0;

  // ── degree distribution & entropy ──────────────────────────────────────
  const degreeCounts = new Map<number, number>();
  let maxDegree = 0;
  for (const node of nodes) {
    const deg = adjList.get(node)?.length ?? 0;
    degreeCounts.set(deg, (degreeCounts.get(deg) ?? 0) + 1);
    if (deg > maxDegree) maxDegree = deg;
  }

  let degreeEntropy = 0;
  if (nodeCount > 0) {
    for (const count of degreeCounts.values()) {
      const p = count / nodeCount;
      if (p > 0) degreeEntropy -= p * Math.log2(p);
    }
  }

  const avgDegree = nodeCount > 0 ? edgeCount / nodeCount : 0;

  // ── flow hierarchy (Kahn's algorithm) ──────────────────────────────────
  // Compute in-degree for all nodes
  const inDegree = new Map<string, number>();
  for (const node of nodes) inDegree.set(node, 0);
  for (const targets of adjList.values()) {
    for (const tgt of targets) {
      inDegree.set(tgt, (inDegree.get(tgt) ?? 0) + 1);
    }
  }

  // Queue nodes with 0 in-degree
  const queue: string[] = [];
  const inAcyclic = new Set<string>();
  for (const node of nodes) {
    if (inDegree.get(node) === 0) {
      queue.push(node);
      inAcyclic.add(node);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of adjList.get(current) ?? []) {
      const newIndeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newIndeg);
      if (newIndeg === 0 && !inAcyclic.has(neighbor)) {
        inAcyclic.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  // Count hierarchical edges (edge source is in the acyclic subgraph)
  let hierarchicalEdges = 0;
  for (const [src, targets] of adjList) {
    if (inAcyclic.has(src)) {
      hierarchicalEdges += targets.length;
    }
  }

  const flowHierarchy = edgeCount > 0 ? hierarchicalEdges / edgeCount : 0;

  // ── modularity Q (Newman-Girvan) ───────────────────────────────────────
  let modularityQ = 0;
  if (communities && communities.size > 0 && edgeCount > 0) {
    // Build degree map
    const degree = new Map<string, number>();
    for (const node of nodes) {
      degree.set(node, adjList.get(node)?.length ?? 0);
    }
    // Also account for incoming edges (undirected modularity view)
    for (const targets of adjList.values()) {
      for (const tgt of targets) {
        degree.set(tgt, (degree.get(tgt) ?? 0) + 1);
      }
    }

    const twoM = 2 * edgeCount;

    // Build community lookup: nodeId → communityId
    const nodeToCommunity = new Map<string, string>();
    for (const [commId, members] of communities) {
      for (const member of members) {
        nodeToCommunity.set(member, commId);
      }
    }

    // Only consider nodes present in the graph
    for (const node of nodes) {
      if (!nodeToCommunity.has(node)) {
        // unassigned node gets its own community
        nodeToCommunity.set(node, '_unassigned_' + node);
      }
    }

    // Q = (1/2m) * Σ_ij [A_ij - (k_i * k_j)/(2m)] * δ(c_i, c_j)
    let qAcc = 0;
    for (const [src, targets] of adjList) {
      const ki = degree.get(src) ?? 0;
      const ci = nodeToCommunity.get(src) ?? '';
      for (const tgt of targets) {
        const kj = degree.get(tgt) ?? 0;
        const cj = nodeToCommunity.get(tgt) ?? '';
        if (ci === cj) {
          qAcc += 1 - (ki * kj) / twoM;
        }
      }
    }

    modularityQ = qAcc / twoM;
  }

  // ── topology classification ────────────────────────────────────────────
  let topologyType: SpectralMetrics['topologyType'] = 'hybrid';
  let topologyConfidence = 0.5;

  // Star-like: single hub connects to >50% of nodes, low avg degree
  if (nodeCount > 1 && maxDegree >= nodeCount * 0.5 && avgDegree < 3) {
    topologyType = 'star-like';
    topologyConfidence = maxDegree >= nodeCount * 0.8 ? 0.9 : 0.7;
  }
  // Tree-like: at most V-1 edges (sparse) OR density < 0.1
  if (nodeCount > 1) {
    const isSparse = edgeCount <= nodeCount - 1 || density < 0.1;
    if (isSparse && topologyType !== 'star-like') {
      topologyType = 'tree-like';
      topologyConfidence = edgeCount <= nodeCount - 1 ? 0.9 : 0.7;
    }
  }
  // Mesh-like: density > 0.3 AND avg degree > 5
  if (density > 0.3 && avgDegree > 5) {
    topologyType = 'mesh-like';
    topologyConfidence = density > 0.5 ? 0.9 : 0.7;
  }

  return {
    nodeCount,
    edgeCount,
    density,
    degreeEntropy,
    avgDegree,
    maxDegree,
    flowHierarchy,
    modularityQ,
    topologyType,
    topologyConfidence,
  };
}
