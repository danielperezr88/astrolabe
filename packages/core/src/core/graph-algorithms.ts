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
