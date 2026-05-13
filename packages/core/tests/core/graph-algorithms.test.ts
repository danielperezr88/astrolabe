import { describe, it, expect } from 'vitest';
import { pageRank, betweennessCentrality, shortestPath, detectClones, computeSpectralMetrics, detectCutVertices, detectBridges } from '../../src/core/graph-algorithms.js';

// ── PageRank Tests ──────────────────────────────────────────────────────────

describe('pageRank', () => {
  it('ranks a simple chain A→B→C with C having highest score', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['C']],
      ['C', []],
    ]);

    const result = pageRank(adj);

    expect(result).toHaveLength(3);
    // C is a dangling node (sink) that accumulates rank from the chain
    expect(result[0].nodeId).toBe('C');
    // Sum of all scores should be ~1
    const totalScore = result.reduce((sum, r) => sum + r.score, 0);
    expect(totalScore).toBeCloseTo(1, 4);
  });

  it('returns empty array for empty graph', () => {
    const result = pageRank(new Map());
    expect(result).toEqual([]);
  });

  it('assigns uniform scores to isolated nodes (no edges)', () => {
    const adj = new Map<string, string[]>([
      ['X', []],
      ['Y', []],
      ['Z', []],
    ]);

    const result = pageRank(adj);

    expect(result).toHaveLength(3);
    // All scores should be approximately equal (1/3)
    for (const r of result) {
      expect(r.score).toBeCloseTo(1 / 3, 4);
    }
  });

  it('gives hub node higher rank in star topology', () => {
    // Hub → A, Hub → B, Hub → C
    const adj = new Map<string, string[]>([
      ['Hub', ['A', 'B', 'C']],
      ['A', ['Hub']],
      ['B', ['Hub']],
      ['C', ['Hub']],
    ]);

    const result = pageRank(adj);

    // Hub should have the highest score (most links point to it)
    expect(result[0].nodeId).toBe('Hub');
  });
});

// ── Betweenness Centrality Tests ────────────────────────────────────────────

describe('betweennessCentrality', () => {
  it('identifies bridge node in a linear chain A-B-C-D', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['C']],
      ['C', ['D']],
      ['D', []],
    ]);

    const result = betweennessCentrality(adj);

    // B and C are bridge nodes (shortest paths pass through them)
    // B and C should have higher scores than A and D
    const bScore = result.find((r) => r.nodeId === 'B')!.score;
    const aScore = result.find((r) => r.nodeId === 'A')!.score;
    const dScore = result.find((r) => r.nodeId === 'D')!.score;

    expect(bScore).toBeGreaterThan(aScore);
    expect(bScore).toBeGreaterThan(dScore);
  });

  it('returns empty array for empty graph', () => {
    const result = betweennessCentrality(new Map());
    expect(result).toEqual([]);
  });

  it('assigns zero to all nodes in a clique (fully connected)', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B', 'C']],
      ['B', ['A', 'C']],
      ['C', ['A', 'B']],
    ]);

    const result = betweennessCentrality(adj);

    // In a complete graph, no node is a bridge — all centrality is 0
    for (const r of result) {
      expect(r.score).toBeCloseTo(0, 4);
    }
  });

  it('identifies the central node in a star graph', () => {
    // Center connects to all leaves; leaves connect to center
    const adj = new Map<string, string[]>([
      ['Center', ['L1', 'L2', 'L3']],
      ['L1', ['Center']],
      ['L2', ['Center']],
      ['L3', ['Center']],
    ]);

    const result = betweennessCentrality(adj);

    // Center has the highest betweenness (all paths go through it)
    expect(result[0].nodeId).toBe('Center');
    expect(result[0].score).toBeGreaterThan(0);
  });
});

// ── Shortest Path Tests ────────────────────────────────────────────────────

describe('shortestPath', () => {
  it('finds direct path between adjacent nodes', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['C']],
      ['C', []],
    ]);

    const path = shortestPath(adj, 'A', 'B');

    expect(path).toEqual(['A', 'B']);
  });

  it('finds multi-hop path through intermediate nodes', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['C']],
      ['C', ['D']],
      ['D', []],
    ]);

    const path = shortestPath(adj, 'A', 'D');

    expect(path).toEqual(['A', 'B', 'C', 'D']);
  });

  it('returns null when no path exists', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', []],
      ['C', ['D']],
      ['D', []],
    ]);

    const path = shortestPath(adj, 'A', 'D');

    expect(path).toBeNull();
  });

  it('returns single-element path when source equals target', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', []],
    ]);

    const path = shortestPath(adj, 'A', 'A');

    expect(path).toEqual(['A']);
  });

  it('finds path using reverse edges (undirected traversal)', () => {
    // Directed: A→B→C. Can we go from C to A?
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['C']],
      ['C', []],
    ]);

    const path = shortestPath(adj, 'C', 'A');

    expect(path).toEqual(['C', 'B', 'A']);
  });

  it('returns null for unknown nodes', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', []],
    ]);

    const path = shortestPath(adj, 'A', 'Z');

    expect(path).toBeNull();
  });
});

// ── Clone Detection Tests ──────────────────────────────────────────────────

describe('detectClones', () => {
  it('detects structurally identical functions as exact clones', () => {
    // Two functions with identical call patterns: each calls 2 helpers
    const adj = new Map<string, string[]>([
      ['FuncA', ['Helper1', 'Helper2']],
      ['FuncB', ['Helper3', 'Helper4']],
      ['Helper1', []],
      ['Helper2', []],
      ['Helper3', []],
      ['Helper4', []],
    ]);
    const names = new Map(Object.entries({
      FuncA: 'processOrder', FuncB: 'processPayment',
      Helper1: 'validate', Helper2: 'transform',
      Helper3: 'check', Helper4: 'convert',
    }));

    const result = detectClones(adj, names, { threshold: 0.6 });
    expect(result.totalFunctions).toBe(6);

    // FuncA and FuncB should be detected as clones (same out-degree, structurally identical)
    const abPair = result.topPairs.find(
      (p) => (p.functionA.name === 'processOrder' && p.functionB.name === 'processPayment') ||
             (p.functionA.name === 'processPayment' && p.functionB.name === 'processOrder')
    );
    expect(abPair).toBeDefined();
    if (abPair) expect(abPair.similarity).toBeGreaterThan(0.8);
  });

  it('returns empty result for graph with no similar functions', () => {
    // All functions have unique structures
    const adj = new Map<string, string[]>([
      ['A', ['B', 'C']],
      ['B', ['C']],
      ['C', []],
    ]);
    const names = new Map(Object.entries({
      A: 'fnA', B: 'fnB', C: 'fnC',
    }));

    const result = detectClones(adj, names, { threshold: 0.9 });
    // No two functions share the same WL hash
    expect(result.totalPairs).toBe(0);
    expect(result.clusters).toHaveLength(0);
  });

  it('handles empty graph', () => {
    const result = detectClones(new Map(), new Map());
    expect(result.totalFunctions).toBe(0);
    expect(result.totalPairs).toBe(0);
    expect(result.clusters).toEqual([]);
  });

  it('groups similar functions into clusters', () => {
    // Three functions with identical call patterns
    const adj = new Map<string, string[]>([
      ['A', ['H1', 'H2']],
      ['B', ['H3', 'H4']],
      ['C', ['H5', 'H6']],
      ['H1', []], ['H2', []], ['H3', []], ['H4', []], ['H5', []], ['H6', []],
    ]);
    const names = new Map(Object.entries({
      A: 'fnA', B: 'fnB', C: 'fnC',
    }));

    const result = detectClones(adj, names, { threshold: 0.5, minClusterSize: 2 });
    // A, B, C should be in the same cluster
    expect(result.clusters.length).toBeGreaterThan(0);
    const cluster = result.clusters[0];
    expect(cluster.memberCount).toBeGreaterThanOrEqual(2);
  });

  it('respects similarity threshold', () => {
    // Two groups of structurally similar functions
    const adj = new Map<string, string[]>([
      // Group: both call 1 helper (structurally identical)
      ['A', ['HA']],
      ['B', ['HB']],
      // Different structure: calls 2 helpers
      ['C', ['HC', 'HD']],
      // Helpers
      ['HA', []], ['HB', []], ['HC', []], ['HD', []],
    ]);
    const names = new Map(Object.entries({
      A: 'fnA', B: 'fnB', C: 'fnC',
    }));

    // A and B are struct-equals → high similarity (within their WL group)
    const result = detectClones(adj, names, { threshold: 0.5 });
    // A and B should pair; C is different
    expect(result.totalPairs).toBeGreaterThanOrEqual(1);

    // With very high threshold, should still find A-B (they're exact structural matches)
    const resultHigh = detectClones(adj, names, { threshold: 0.95 });
    expect(resultHigh.totalPairs).toBeGreaterThanOrEqual(1);

    // C should not pair with A or B (different WL hash)
    const hasCPair = result.topPairs.some(
      (p) => p.functionA.name === 'fnC' || p.functionB.name === 'fnC'
    );
    expect(hasCPair).toBe(false);
  });
});

// ── Spectral Metrics Tests (#812) ────────────────────────────────────────────

describe('computeSpectralMetrics', () => {
  it('computes correct density for a chain graph', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['C']],
      ['C', ['D']],
      ['D', []],
    ]);
    const metrics = computeSpectralMetrics(adj);
    expect(metrics.nodeCount).toBe(4);
    expect(metrics.edgeCount).toBe(3);
    // density = 3 / (4*3) = 0.25
    expect(metrics.density).toBeCloseTo(0.25, 2);
  });

  it('returns zero density for empty graph', () => {
    const adj = new Map<string, string[]>();
    const metrics = computeSpectralMetrics(adj);
    expect(metrics.nodeCount).toBe(0);
    expect(metrics.edgeCount).toBe(0);
    expect(metrics.density).toBe(0);
  });

  it('classifies tree-like topology for a simple tree', () => {
    const adj = new Map<string, string[]>([
      ['Root', ['A', 'B']],
      ['A', ['A1', 'A2']],
      ['B', []],
      ['A1', []],
      ['A2', []],
    ]);
    const metrics = computeSpectralMetrics(adj);
    expect(metrics.topologyType).toBe('tree-like');
    expect(metrics.topologyConfidence).toBeGreaterThan(0.5);
  });

  it('classifies star-like topology', () => {
    const adj = new Map<string, string[]>([
      ['Hub', ['A', 'B', 'C', 'D', 'E']],
      ['A', ['Hub']],
      ['B', ['Hub']],
      ['C', ['Hub']],
      ['D', ['Hub']],
      ['E', ['Hub']],
    ]);
    const metrics = computeSpectralMetrics(adj);
    expect(metrics.topologyType).toBe('star-like');
  });

  it('computes degree entropy for mixed degree graph', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B', 'C', 'D']],
      ['B', ['C']],
      ['C', []],
      ['D', []],
    ]);
    const metrics = computeSpectralMetrics(adj);
    expect(metrics.degreeEntropy).toBeGreaterThan(0);
    expect(metrics.maxDegree).toBe(3);
  });

  it('computes flow hierarchy for acyclic graph as 1.0', () => {
    // Pure DAG: A→B, A→C, B→D, C→D
    const adj = new Map<string, string[]>([
      ['A', ['B', 'C']],
      ['B', ['D']],
      ['C', ['D']],
      ['D', []],
    ]);
    const metrics = computeSpectralMetrics(adj);
    expect(metrics.flowHierarchy).toBeCloseTo(1.0, 1);
  });

  it('computes flow hierarchy for cyclic graph < 1.0', () => {
    // Cycle: A→B→C→A
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['C']],
      ['C', ['A']],
    ]);
    const metrics = computeSpectralMetrics(adj);
    expect(metrics.flowHierarchy).toBeLessThan(1.0);
  });

  it('computes modularity Q when communities provided', () => {
    // Two clear clusters: cluster1 {A,B} heavily interconnected, cluster2 {C,D} heavily interconnected
    // Weak connection between clusters: B→C
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['A', 'C']],
      ['C', ['D', 'B']],
      ['D', ['C']],
    ]);
    const communities = new Map<string, string[]>([
      ['cluster1', ['A', 'B']],
      ['cluster2', ['C', 'D']],
    ]);
    const metrics = computeSpectralMetrics(adj, communities);
    // Should show positive modularity (inter-cluster edges < intra-cluster)
    expect(metrics.modularityQ).toBeGreaterThan(0);
  });
});

// ── Cut Vertices (Articulation Points) Tests ────────────────────────────────

describe('detectCutVertices', () => {
  it('detects the middle node as cut vertex in a linear chain A-B-C', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['C']],
      ['C', []],
    ]);
    const result = detectCutVertices(adj);
    // B is the only cut vertex — removing it disconnects A from C
    const ids = result.map((r) => r.nodeId);
    expect(ids).toContain('B');
    expect(ids).not.toContain('A');
    expect(ids).not.toContain('C');
  });

  it('returns empty array for a triangle (fully connected 3-cycle)', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B', 'C']],
      ['B', ['A', 'C']],
      ['C', ['A', 'B']],
    ]);
    const result = detectCutVertices(adj);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty graph', () => {
    expect(detectCutVertices(new Map())).toEqual([]);
  });

  it('identifies hub as cut vertex in a star graph', () => {
    // Hub connects all leaves; leaves only connect to hub
    const adj = new Map<string, string[]>([
      ['Hub', ['A', 'B', 'C']],
      ['A', ['Hub']],
      ['B', ['Hub']],
      ['C', ['Hub']],
    ]);
    const result = detectCutVertices(adj);
    const ids = result.map((r) => r.nodeId);
    expect(ids).toContain('Hub');
    expect(ids).not.toContain('A');
  });

  it('detects cut vertices in a dumbbell graph', () => {
    // A-B-C-D-E where C connects two triangles: (A,B,C) and (C,D,E)
    const adj = new Map<string, string[]>([
      ['A', ['B', 'C']],
      ['B', ['A', 'C']],
      ['C', ['A', 'B', 'D', 'E']],
      ['D', ['C', 'E']],
      ['E', ['C', 'D']],
    ]);
    const result = detectCutVertices(adj);
    // C is the only cut vertex connecting the two triangles
    const ids = result.map((r) => r.nodeId);
    expect(ids).toContain('C');
    expect(result).toHaveLength(1);
  });

  it('returns empty for a single isolated node', () => {
    const adj = new Map<string, string[]>([['A', []]]);
    expect(detectCutVertices(adj)).toEqual([]);
  });
});

// ── Bridge Edges Tests ──────────────────────────────────────────────────────

describe('detectBridges', () => {
  it('detects bridges in a linear chain A-B-C', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['C']],
      ['C', []],
    ]);
    const result = detectBridges(adj);
    // Both edges A-B and B-C are bridges in a chain
    expect(result).toHaveLength(2);
  });

  it('returns empty array for a triangle (no bridges)', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B', 'C']],
      ['B', ['A', 'C']],
      ['C', ['A', 'B']],
    ]);
    const result = detectBridges(adj);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty graph', () => {
    expect(detectBridges(new Map())).toEqual([]);
  });

  it('detects bridge in a simple two-node graph', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['A']],
    ]);
    const result = detectBridges(adj);
    expect(result).toHaveLength(1);
    expect(result[0].sourceId).toBe('A');
    expect(result[0].targetId).toBe('B');
  });

  it('detects the bridge edge in a dumbbell graph', () => {
    // Two triangles connected by single edge C-D
    const adj = new Map<string, string[]>([
      ['A', ['B', 'C']],
      ['B', ['A', 'C']],
      ['C', ['A', 'B', 'D']],
      ['D', ['C', 'E', 'F']],
      ['E', ['D', 'F']],
      ['F', ['D', 'E']],
    ]);
    const result = detectBridges(adj);
    expect(result).toHaveLength(1);
    // Edge C-D is the only bridge
  });
});
