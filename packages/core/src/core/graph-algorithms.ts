/**
 * Graph algorithms for architecture analysis.
 *
 * PageRank, betweenness centrality, shortest-path, and architecture
 * anti-pattern detection (Tarjan SCC, hub detection, Martin dependency
 * metrics, bridge edges, mesh detection) on the dependency adjacency
 * list derived from CALLS / IMPORTS / EXTENDS / IMPLEMENTS edges.
 */

export interface GraphAlgorithmResult {
  nodeId: string;
  score: number;
}

// ── Architecture Anti-Pattern Result Types ───────────────────────────────────

/** A strongly connected component detected by Tarjan's algorithm. */
export interface SccResult {
  id: number;
  nodeIds: string[];
  size: number;
}

/** A cut vertex (articulation point) whose removal disconnects the graph. */
export interface CutVertexResult {
  nodeId: string;
  componentCountAfterRemoval: number;
  affectedSubtreeSize: number;
}

/** A bridge edge whose removal disconnects the graph. */
export interface BridgeResult {
  sourceId: string;
  targetId: string;
}

/** Hub-like / god module detection result. */
export interface HubResult {
  nodeId: string;
  fanIn: number;       // afferent coupling (Ca)
  fanOut: number;      // efferent coupling (Ce)
  instability: number; // I = Ce / (Ca + Ce), 0..1
  classification: 'god-module' | 'hub' | 'dependent' | 'isolated';
}

/** Martin dependency metrics per node. */
export interface MartinMetricsResult {
  nodeId: string;
  afferentCoupling: number;   // Ca — incoming dependency count
  efferentCoupling: number;   // Ce — outgoing dependency count
  instability: number;        // I = Ce / (Ca + Ce)
  abstractness: number;       // A = abstract / total (0..1)
  distance: number;           // D = |A + I - 1| — 0 = balanced, 1 = pain zone
}

/** Dependency mesh detection result. */
export interface MeshResult {
  nodeIds: string[];
  edgeCount: number;
  density: number;     // E / (V * (V-1))
  acyclicAnchors: string[];
}

/** Aggregated architecture smells report. */
export interface ArchitectureSmellsResult {
  sccs: SccResult[];
  cutVertices: CutVertexResult[];
  bridges: BridgeResult[];
  hubs: HubResult[];
  martinMetrics: MartinMetricsResult[];
  meshes: MeshResult[];
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

// ── Tarjan's SCC ────────────────────────────────────────────────────────────

/**
 * Tarjan's strongly connected components algorithm.
 *
 * Classic DFS-based algorithm using discovery index and lowlink values.
 * Handles single-node components (self-loops are SCCs).
 * Returns SCCs sorted by size descending with sequential IDs.
 * O(V+E) time complexity.
 */
export function tarjanSCC(adjList: Map<string, string[]>): SccResult[] {
  const nodes = Array.from(adjList.keys());
  if (nodes.length === 0) return [];

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let currentIndex = 0;

  function strongconnect(v: string): void {
    index.set(v, currentIndex);
    lowlink.set(v, currentIndex);
    currentIndex++;
    stack.push(v);
    onStack.add(v);

    const neighbors = adjList.get(v) ?? [];
    for (const w of neighbors) {
      if (index.get(w) === undefined) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      sccs.push(component);
    }
  }

  for (const node of nodes) {
    if (index.get(node) === undefined) {
      strongconnect(node);
    }
  }

  return sccs
    .filter(scc => scc.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((nodeIds, i) => ({
      id: i,
      nodeIds,
      size: nodeIds.length,
    }));
}

// ── Hub Detection ───────────────────────────────────────────────────────────

/**
 * Detects hub-like nodes based on fan-in / fan-out coupling.
 *
 * Classifies nodes as god-module, hub, dependent, or isolated using
 * configurable thresholds.  Computes instability I = fanOut / (fanIn + fanOut).
 * Includes nodes that only appear as targets (not source keys).
 * Results sorted by total coupling (fanIn + fanOut) descending.
 */
export function detectHubs(
  adjList: Map<string, string[]>,
  fanInThreshold: number = 3,
  fanOutThreshold: number = 3,
): HubResult[] {
  const nodes = Array.from(adjList.keys());

  // Build reverse adjacency for fan-in computation
  const reverseAdj = new Map<string, string[]>();
  for (const node of nodes) reverseAdj.set(node, []);
  for (const [src, targets] of adjList) {
    for (const tgt of targets) {
      let bucket = reverseAdj.get(tgt);
      if (!bucket) {
        bucket = [];
        reverseAdj.set(tgt, bucket);
      }
      bucket.push(src);
    }
  }

  const results: HubResult[] = [];

  for (const node of nodes) {
    const fanOut = adjList.get(node)?.length ?? 0;
    const fanIn = reverseAdj.get(node)?.length ?? 0;
    const total = fanIn + fanOut;
    const instability = total === 0 ? 0 : fanOut / total;

    let classification: HubResult['classification'];
    if (total === 0) {
      classification = 'isolated';
    } else if (fanIn >= fanInThreshold && fanOut >= fanOutThreshold) {
      classification = 'god-module';
    } else if (fanIn >= fanInThreshold) {
      classification = 'hub';
    } else if (fanOut >= fanOutThreshold) {
      classification = 'dependent';
    } else {
      classification = 'isolated';
    }

    results.push({ nodeId: node, fanIn, fanOut, instability, classification });
  }

  // Include nodes that only appear as targets (not keys in adjList)
  for (const [node] of reverseAdj) {
    if (!adjList.has(node)) {
      const fanIn = reverseAdj.get(node)?.length ?? 0;
      const fanOut = 0;
      let classification: HubResult['classification'];
      if (fanIn >= fanInThreshold) {
        classification = 'hub';
      } else {
        classification = 'isolated';
      }
      results.push({
        nodeId: node,
        fanIn,
        fanOut,
        instability: 0,
        classification,
      });
    }
  }

  return results.sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut));
}

// ── Martin Dependency Metrics ──────────────────────────────────────────────

/**
 * Computes Martin's instability/abstractness metrics per node.
 *
 * Ca (afferent coupling)  = incoming dependency count.
 * Ce (efferent coupling)  = outgoing dependency count.
 * I (instability)         = Ce / (Ca + Ce), 0 if both zero.
 * A (abstractness)        = 1.0 if the node's label contains "interface",
 *                           "abstract", or "abstract class" (case-insensitive);
 *                           otherwise 0.0.  If nodeLabels is not provided, A = 0.
 * D (distance)            = |A + I - 1| — 0 = balanced, 1 = pain zone.
 *
 * Results sorted by distance descending (most imbalanced first).
 */
export function martinDependencyMetrics(
  adjList: Map<string, string[]>,
  nodeLabels?: Map<string, string>,
): MartinMetricsResult[] {
  const nodes = Array.from(adjList.keys());

  // Build reverse adjacency for afferent coupling (Ca)
  const reverseAdj = new Map<string, string[]>();
  for (const node of nodes) reverseAdj.set(node, []);
  for (const [src, targets] of adjList) {
    for (const tgt of targets) {
      let bucket = reverseAdj.get(tgt);
      if (!bucket) {
        bucket = [];
        reverseAdj.set(tgt, bucket);
      }
      bucket.push(src);
    }
  }

  const results: MartinMetricsResult[] = [];
  const abstractPattern = /interface|abstract|abstract\s+class/i;

  for (const node of nodes) {
    const ca = reverseAdj.get(node)?.length ?? 0;
    const ce = adjList.get(node)?.length ?? 0;
    const instability = ca + ce === 0 ? 0 : ce / (ca + ce);

    let abstractness = 0;
    if (nodeLabels) {
      const label = nodeLabels.get(node) ?? '';
      if (abstractPattern.test(label)) {
        abstractness = 1;
      }
    }

    const distance = Math.abs(abstractness + instability - 1);

    results.push({
      nodeId: node,
      afferentCoupling: ca,
      efferentCoupling: ce,
      instability,
      abstractness,
      distance,
    });
  }

  return results.sort((a, b) => b.distance - a.distance);
}

// ── Mesh Detection ─────────────────────────────────────────────────────────

/**
 * Detects dependency meshes — densely-connected strongly connected components.
 *
 * Uses tarjanSCC internally.  For each SCC of size ≥ 3, computes edge density
 * as edgeCount / (nodeCount × (nodeCount - 1)).  A mesh is an SCC whose
 * density reaches the threshold (default 0.5).
 *
 * acyclicAnchors are mesh nodes with the fewest outgoing edges to other
 * mesh members.
 *
 * Results sorted by density descending.
 */
export function detectMesh(
  adjList: Map<string, string[]>,
  densityThreshold: number = 0.5,
): MeshResult[] {
  const sccs = tarjanSCC(adjList);
  const results: MeshResult[] = [];

  for (const scc of sccs) {
    if (scc.size < 3) continue;

    const nodeSet = new Set(scc.nodeIds);
    let edgeCount = 0;
    const outCounts = new Map<string, number>();

    for (const node of scc.nodeIds) {
      const targets = adjList.get(node) ?? [];
      let outToMesh = 0;
      for (const tgt of targets) {
        if (nodeSet.has(tgt)) {
          edgeCount++;
          outToMesh++;
        }
      }
      outCounts.set(node, outToMesh);
    }

    const n = scc.size;
    const density = edgeCount / (n * (n - 1));

    if (density >= densityThreshold) {
      let minOut = Infinity;
      for (const count of outCounts.values()) {
        if (count < minOut) minOut = count;
      }

      const acyclicAnchors: string[] = [];
      for (const [node, count] of outCounts) {
        if (count === minOut) acyclicAnchors.push(node);
      }

      results.push({
        nodeIds: scc.nodeIds,
        edgeCount,
        density,
        acyclicAnchors,
      });
    }
  }

  return results.sort((a, b) => b.density - a.density);
}

// ── Bridge Detection ───────────────────────────────────────────────────────

/**
 * Tarjan's bridge-finding algorithm treating the graph as undirected.
 *
 * A bridge is an edge whose removal increases the number of connected
 * components.  Uses discovery time and low values in a single DFS pass.
 * For bridge detection, an edge u→v implies u and v are connected
 * in both directions.
 */
export function detectBridges(adjList: Map<string, string[]>): BridgeResult[] {
  const nodes = Array.from(adjList.keys());
  if (nodes.length === 0) return [];

  // Build undirected adjacency (edge u→v means u connected to v and vice versa)
  const undirected = new Map<string, string[]>();
  for (const node of nodes) undirected.set(node, []);
  for (const [u, targets] of adjList) {
    for (const v of targets) {
      const uNeighbors = undirected.get(u)!;
      if (!uNeighbors.includes(v)) uNeighbors.push(v);
      const vBucket = undirected.get(v);
      if (vBucket) {
        if (!vBucket.includes(u)) vBucket.push(u);
      } else {
        undirected.set(v, [u]);
      }
    }
  }

  const allNodes = Array.from(undirected.keys());
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string>();
  const bridges: BridgeResult[] = [];
  let time = 0;

  function dfs(u: string): void {
    disc.set(u, time);
    low.set(u, time);
    time++;

    const neighbors = undirected.get(u) ?? [];
    for (const v of neighbors) {
      if (disc.get(v) === undefined) {
        parent.set(v, u);
        dfs(v);
        low.set(u, Math.min(low.get(u)!, low.get(v)!));
        if (low.get(v)! > disc.get(u)!) {
          bridges.push({ sourceId: u, targetId: v });
        }
      } else if (v !== (parent.get(u) ?? '')) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }
  }

  for (const node of allNodes) {
    if (disc.get(node) === undefined) {
      dfs(node);
    }
  }

  return bridges;
}

// ── Cut Vertex Detection ────────────────────────────────────────────────────

/**
 * Articulation point (cut-vertex) detection via a single DFS.
 *
 * A cut vertex is a node whose removal disconnects the graph.  The graph
 * is treated as undirected.  For the DFS root, it's a cut vertex if it
 * has more than one child.  For non-root nodes, node u is a cut vertex
 * if for any child v, low[v] ≥ disc[u].
 *
 * Results sorted by componentCountAfterRemoval descending.
 */
export function detectCutVertices(adjList: Map<string, string[]>): CutVertexResult[] {
  const nodes = Array.from(adjList.keys());
  if (nodes.length === 0) return [];

  // Build undirected adjacency
  const undirected = new Map<string, string[]>();
  for (const node of nodes) undirected.set(node, []);
  for (const [u, targets] of adjList) {
    for (const v of targets) {
      const uNeighbors = undirected.get(u)!;
      if (!uNeighbors.includes(v)) uNeighbors.push(v);
      const vBucket = undirected.get(v);
      if (vBucket) {
        if (!vBucket.includes(u)) vBucket.push(u);
      } else {
        undirected.set(v, [u]);
      }
    }
  }

  const allNodes = Array.from(undirected.keys());
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string>();
  const subtreeSize = new Map<string, number>();
  const isCutVertex = new Map<string, boolean>();
  const cutChildCount = new Map<string, number>();
  let time = 0;

  function dfs(u: string, isRoot: boolean): void {
    disc.set(u, time);
    low.set(u, time);
    time++;

    let size = 1;
    let children = 0;
    let cuts = 0;

    const neighbors = undirected.get(u) ?? [];
    for (const v of neighbors) {
      if (disc.get(v) === undefined) {
        children++;
        parent.set(v, u);
        dfs(v, false);
        size += subtreeSize.get(v)!;
        low.set(u, Math.min(low.get(u)!, low.get(v)!));

        if (!isRoot && low.get(v)! >= disc.get(u)!) {
          isCutVertex.set(u, true);
          cuts++;
        }
      } else if (v !== (parent.get(u) ?? '')) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }

    subtreeSize.set(u, size);

    if (isRoot && children > 1) {
      isCutVertex.set(u, true);
      cuts = children;
    }

    cutChildCount.set(u, cuts);
  }

  for (const node of allNodes) {
    if (disc.get(node) === undefined) {
      dfs(node, true);
    }
  }

  const results: CutVertexResult[] = [];
  for (const node of allNodes) {
    if (isCutVertex.get(node)) {
      const isRoot = parent.get(node) === undefined;
      const childCount = cutChildCount.get(node) ?? 0;
      const componentCountAfterRemoval = isRoot ? childCount : childCount + 1;

      let affectedSubtreeSize = 0;
      const neighbors = undirected.get(node) ?? [];
      for (const v of neighbors) {
        if (parent.get(v) === node) {
          if (isRoot || low.get(v)! >= disc.get(node)!) {
            affectedSubtreeSize += subtreeSize.get(v)!;
          }
        }
      }

      results.push({
        nodeId: node,
        componentCountAfterRemoval,
        affectedSubtreeSize,
      });
    }
  }

  return results.sort((a, b) => b.componentCountAfterRemoval - a.componentCountAfterRemoval);
}

// ── Architecture Smells (Orchestrator) ─────────────────────────────────────

/**
 * Aggregated architecture-smells report.
 *
 * Calls all architecture anti-pattern detectors and returns a combined result.
 * Passes options through to the respective sub-functions:
 *   fanInThreshold / fanOutThreshold → detectHubs
 *   densityThreshold → detectMesh
 *   nodeLabels → martinDependencyMetrics
 */
export function architectureSmells(
  adjList: Map<string, string[]>,
  options?: {
    fanInThreshold?: number;
    fanOutThreshold?: number;
    densityThreshold?: number;
    nodeLabels?: Map<string, string>;
  },
): ArchitectureSmellsResult {
  return {
    sccs: tarjanSCC(adjList),
    cutVertices: detectCutVertices(adjList),
    bridges: detectBridges(adjList),
    hubs: detectHubs(adjList, options?.fanInThreshold, options?.fanOutThreshold),
    martinMetrics: martinDependencyMetrics(adjList, options?.nodeLabels),
    meshes: detectMesh(adjList, options?.densityThreshold),
  };
}
