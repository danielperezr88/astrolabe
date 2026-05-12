import { describe, it, expect } from 'vitest';
import { pageRank, betweennessCentrality, shortestPath, detectCutVertices, detectBridges } from '../../src/core/graph-algorithms.js';

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
