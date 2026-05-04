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

      // Also consider reverse edges (undirected view)
      // Nodes that point TO v should be treated as neighbors too
      for (const [potentialNeighbor, targets] of adjList) {
        if (targets.includes(v) && !neighbors.includes(potentialNeighbor)) {
          const w = potentialNeighbor;
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
