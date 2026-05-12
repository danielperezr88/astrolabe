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

// ── Clone Detection (Weisfeiler-Lehman Graph Kernel) ────────────────────────

/**
 * Build a reverse adjacency map: for each node, which nodes point TO it.
 * Not exported — used internally by detectClones().
 */
function buildReverseAdj(adjList: Map<string, string[]>): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const node of adjList.keys()) reverse.set(node, []);
  for (const [src, targets] of adjList) {
    for (const tgt of targets) {
      const bucket = reverse.get(tgt);
      if (bucket) bucket.push(src);
      else reverse.set(tgt, [src]);
    }
  }
  return reverse;
}

/**
 * Simple polynomial hash function for WL label generation.
 * Not cryptographic — used for structural equivalence grouping.
 */
function wlHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash * 33) + input.charCodeAt(i)) & 0x7FFFFFFF;
  }
  return hash.toString(16);
}

export interface ClonePair {
  functionA: { id: string; name: string };
  functionB: { id: string; name: string };
  similarity: number;  // 0-1, Jaccard on feature vector
  sharedNeighbors: number;
}

export interface CloneDetectionResult {
  totalFunctions: number;
  totalPairs: number;
  clusters: CloneCluster[];
  topPairs: ClonePair[];  // top 20 by similarity
  summary: {
    exactClones: number;    // similarity >= 0.95
    nearMisses: number;     // 0.8-0.95
    potentialClones: number; // 0.6-0.8
  };
}

export interface CloneCluster {
  clusterId: number;
  memberCount: number;
  members: Array<{ id: string; name: string }>;
  avgSimilarity: number;
  representativeFunction: string;
}

/**
 * Detect structurally similar functions using the Weisfeiler-Lehman
 * graph kernel (2-iteration refinement).
 *
 * Stage 1: WL hash pre-filter — group nodes with identical structural signatures.
 * Stage 2: Within each group, compute Jaccard similarity on neighbor sets.
 *
 * Only compares pairs that share the same WL hash, avoiding O(N²).
 *
 * @param adjList    Adjacency map (node → outgoing neighbors)
 * @param nodeNames  Node ID → human-readable name map
 * @param options    threshold (0-1), minClusterSize, maxPairs
 */
export function detectClones(
  adjList: Map<string, string[]>,
  nodeNames: Map<string, string>,
  options?: { threshold?: number; minClusterSize?: number; maxPairs?: number },
): CloneDetectionResult {
  const threshold = options?.threshold ?? 0.6;
  const minClusterSize = options?.minClusterSize ?? 2;
  const maxPairs = options?.maxPairs ?? 20;

  const nodes = Array.from(adjList.keys());
  const n = nodes.length;

  if (n === 0) {
    return {
      totalFunctions: 0,
      totalPairs: 0,
      clusters: [],
      topPairs: [],
      summary: { exactClones: 0, nearMisses: 0, potentialClones: 0 },
    };
  }

  // ── Stage 0: Pre-compute degrees and reverse adjacency ────────────────
  const reverseAdj = buildReverseAdj(adjList);

  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    outDegree.set(node, adjList.get(node)?.length ?? 0);
    inDegree.set(node, reverseAdj.get(node)?.length ?? 0);
  }

  // ── Stage 1: WL Hash (2 iterations) ───────────────────────────────────

  // Initial label: degree signature
  const labels = new Map<string, string>();
  for (const node of nodes) {
    const out = outDegree.get(node) ?? 0;
    const inv = inDegree.get(node) ?? 0;
    labels.set(node, `d:${out},${inv}`);
  }

  // 2 iterations of WL refinement
  for (let iter = 0; iter < 2; iter++) {
    const nextLabels = new Map<string, string>();
    for (const node of nodes) {
      const neighborLabels: string[] = [];
      for (const neighbor of adjList.get(node) ?? []) {
        neighborLabels.push(labels.get(neighbor) ?? '');
      }
      neighborLabels.sort();
      const combined = (labels.get(node) ?? '') + '|' + neighborLabels.join(',');
      nextLabels.set(node, wlHash(combined));
    }
    for (const [node, label] of nextLabels) {
      labels.set(node, label);
    }
  }

  // ── Stage 2: Group by WL hash, compare within groups ──────────────────

  // Build neighbor WL hash sets for each node (for structural Jaccard)
  const neighborHashSets = new Map<string, Set<string>>();
  for (const node of nodes) {
    const hashSet = new Set<string>();
    for (const neighbor of adjList.get(node) ?? []) {
      hashSet.add(labels.get(neighbor) ?? '');
    }
    neighborHashSets.set(node, hashSet);
  }

  // Group nodes by final WL hash
  const hashGroups = new Map<string, string[]>();
  for (const node of nodes) {
    const hash = labels.get(node) ?? '';
    const group = hashGroups.get(hash);
    if (group) group.push(node);
    else hashGroups.set(hash, [node]);
  }

  // Compare pairs within each group using neighbor WL hash Jaccard
  const allPairs: ClonePair[] = [];

  for (const [, group] of hashGroups) {
    if (group.length < 2) continue;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];

        const setA = neighborHashSets.get(a)!;
        const setB = neighborHashSets.get(b)!;

        // Jaccard similarity on neighbor WL hashes (structural equivalence)
        let intersection = 0;
        for (const item of setA) {
          if (setB.has(item)) intersection++;
        }
        const union = setA.size + setB.size - intersection;
        const similarity = union === 0 ? 1 : intersection / union;

        if (similarity >= threshold) {
          allPairs.push({
            functionA: { id: a, name: nodeNames.get(a) ?? a },
            functionB: { id: b, name: nodeNames.get(b) ?? b },
            similarity,
            sharedNeighbors: intersection,
          });
        }
      }
    }
  }

  // Sort by similarity descending
  allPairs.sort((a, b) => b.similarity - a.similarity);

  // ── Stage 3: Union-Find Clustering ────────────────────────────────────

  const parent = new Map<string, string>();
  const size = new Map<string, number>();

  function find(x: string): string {
    let p = parent.get(x);
    if (p === undefined) {
      parent.set(x, x);
      size.set(x, 1);
      return x;
    }
    if (p !== x) {
      const root = find(p);
      parent.set(x, root);
      return root;
    }
    return x;
  }

  function union(x: string, y: string): void {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return;
    const sx = size.get(rx) ?? 1;
    const sy = size.get(ry) ?? 1;
    if (sx < sy) {
      parent.set(rx, ry);
      size.set(ry, sx + sy);
    } else {
      parent.set(ry, rx);
      size.set(rx, sx + sy);
    }
  }

  // Initialize all nodes
  for (const node of nodes) find(node);

  // Union pairs above threshold
  for (const pair of allPairs) {
    union(pair.functionA.id, pair.functionB.id);
  }

  // Collect clusters
  const clusterMap = new Map<string, Array<{ id: string; name: string }>>();
  for (const node of nodes) {
    const root = find(node);
    const cluster = clusterMap.get(root);
    const member = { id: node, name: nodeNames.get(node) ?? node };
    if (cluster) cluster.push(member);
    else clusterMap.set(root, [member]);
  }

  // Build cluster results (only multi-member clusters)
  const clusters: CloneCluster[] = [];
  const clusterPairMap = new Map<string, ClonePair[]>();

  for (const pair of allPairs) {
    const root = find(pair.functionA.id); // both nodes share same root after union

    const group = clusterPairMap.get(root);
    if (group) group.push(pair);
    else clusterPairMap.set(root, [pair]);
  }

  let clusterIdCounter = 0;
  for (const [root, members] of clusterMap) {
    if (members.length < minClusterSize) continue;

    const pairs = clusterPairMap.get(root) ?? [];
    const avgSimilarity = pairs.length > 0
      ? pairs.reduce((sum, p) => sum + p.similarity, 0) / pairs.length
      : 1;

    // Representative: highest total similarity to other members (or first member)
    let rep = members[0];
    let bestScore = -1;
    for (const m of members) {
      let score = 0;
      for (const p of pairs) {
        if (p.functionA.id === m.id || p.functionB.id === m.id) {
          score += p.similarity;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        rep = m;
      }
    }

    clusters.push({
      clusterId: clusterIdCounter++,
      memberCount: members.length,
      members,
      avgSimilarity: Math.round(avgSimilarity * 10000) / 10000,
      representativeFunction: rep.name,
    });
  }

  // Sort clusters by size descending
  clusters.sort((a, b) => b.memberCount - a.memberCount);

  // ── Summary counts ────────────────────────────────────────────────────

  const topPairs = allPairs.slice(0, maxPairs);
  let exactClones = 0;
  let nearMisses = 0;
  let potentialClones = 0;

  for (const p of allPairs) {
    if (p.similarity >= 0.95) exactClones++;
    else if (p.similarity >= 0.8) nearMisses++;
    else if (p.similarity >= 0.6) potentialClones++;
  }

  return {
    totalFunctions: n,
    totalPairs: allPairs.length,
    clusters,
    topPairs,
    summary: { exactClones, nearMisses, potentialClones },
  };
}
