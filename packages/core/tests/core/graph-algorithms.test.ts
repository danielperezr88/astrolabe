import { describe, it, expect } from 'vitest';
import { pageRank, betweennessCentrality, shortestPath, detectClones } from '../../src/core/graph-algorithms.js';

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
