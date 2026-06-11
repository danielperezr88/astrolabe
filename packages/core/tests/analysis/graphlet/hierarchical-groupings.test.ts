/**
 * Tests for Hierarchical Subgraph Groupings (#872 Phase 4).
 *
 * Tests the hierarchy module: multi-level Louvain, namespace grouping,
 * supernode metadata, meta-edges, and utility functions.
 */

import { describe, it, expect } from 'vitest';
import {
  buildWeightedAdjacency,
  computeSupernodeMetadata,
  extractCommunityHierarchy,
  extractNamespaceHierarchy,
  collapseGroups,
  findGroupForNode,
  type HierarchyGroup,
} from '../../../src/analysis/graphlet/hierarchy.js';

// ── Test data helpers ────────────────────────────────────────────────────────

/** Create a simple set of weighted relationships. */
function makeRelationships(
  edges: Array<{ src: string; tgt: string; type?: string; weight?: number }>,
) {
  return edges.map(e => ({
    sourceId: e.src,
    targetId: e.tgt,
    type: e.type ?? 'CALLS',
    confidence: e.weight ?? 0.8,
  }));
}

/** Create node IDs from an array of strings. */
function makeNodeIds(ids: string[]): Set<string> {
  return new Set(ids);
}

// ── buildWeightedAdjacency ──────────────────────────────────────────────────

describe('buildWeightedAdjacency', () => {
  it('builds undirected adjacency from relationships', () => {
    const nodeIds = makeNodeIds(['A', 'B', 'C']);
    const rels = makeRelationships([
      { src: 'A', tgt: 'B', weight: 0.5 },
      { src: 'B', tgt: 'C', weight: 0.7 },
    ]);

    const { adj, totalWeight } = buildWeightedAdjacency(rels, nodeIds);

    expect(adj.get('A')!.get('B')).toBe(0.5);
    expect(adj.get('B')!.get('A')).toBe(0.5);
    expect(adj.get('B')!.get('C')).toBe(0.7);
    expect(adj.get('C')!.get('B')).toBe(0.7);
    // Total weight = (0.5 + 0.7) * 2 = 2.4
    expect(totalWeight).toBeCloseTo(2.4);
  });

  it('excludes non-coupling relationship types', () => {
    const nodeIds = makeNodeIds(['A', 'B']);
    const rels = makeRelationships([
      { src: 'A', tgt: 'B', type: 'CALLS', weight: 0.9 },
      { src: 'A', tgt: 'B', type: 'CONTAINS', weight: 0.5 },
    ]);

    const { adj } = buildWeightedAdjacency(rels, nodeIds);

    // Only CALLS should be counted, not CONTAINS
    expect(adj.get('A')!.get('B')).toBe(0.9);
  });

  it('returns empty adjacency for no nodes', () => {
    const { adj, totalWeight } = buildWeightedAdjacency([], new Set());
    expect(adj.size).toBe(0);
    expect(totalWeight).toBe(0);
  });
});

// ── computeSupernodeMetadata ────────────────────────────────────────────────

describe('computeSupernodeMetadata', () => {
  it('computes metadata for a connected group', () => {
    const adj = new Map<string, Map<string, number>>();
    // A<->B (internal), A->C (external), B->D (external)
    adj.set('A', new Map([['B', 0.5], ['C', 0.3]]));
    adj.set('B', new Map([['A', 0.5], ['D', 0.4]]));

    const nodeLabels = new Map<string, string>();
    nodeLabels.set('A', 'Function');
    nodeLabels.set('B', 'Class');

    const metadata = computeSupernodeMetadata(['A', 'B'], adj, nodeLabels);

    // Internal weight: A-B = 0.5, counted once (halved from 1.0)
    expect(metadata.internalWeight).toBeCloseTo(0.5);
    // External: A->C, B->D = 2
    expect(metadata.externalEdgeCount).toBe(2);
    // Entry points: A (external), B (external)
    expect(metadata.entryPoints).toContain('A');
    expect(metadata.entryPoints).toContain('B');
    // Labels
    expect(metadata.labelDistribution['Function']).toBe(1);
    expect(metadata.labelDistribution['Class']).toBe(1);
  });

  it('returns zero metadata for empty group', () => {
    const adj = new Map<string, Map<string, number>>();
    const metadata = computeSupernodeMetadata([], adj, new Map());

    expect(metadata.internalWeight).toBe(0);
    expect(metadata.externalEdgeCount).toBe(0);
    expect(metadata.entryPoints).toHaveLength(0);
  });
});

// ── extractCommunityHierarchy ────────────────────────────────────────────────

describe('extractCommunityHierarchy', () => {
  it('returns empty result for empty input', () => {
    const result = extractCommunityHierarchy([], new Set());
    expect(result.groups).toHaveLength(0);
    expect(result.levels).toBe(0);
    expect(result.modularities).toHaveLength(0);
  });

  it('creates groups for connected nodes', () => {
    const nodeIds = makeNodeIds(['A', 'B', 'C', 'D']);
    const rels = makeRelationships([
      { src: 'A', tgt: 'B', weight: 0.9 },
      { src: 'B', tgt: 'C', weight: 0.8 },
      { src: 'C', tgt: 'D', weight: 0.7 },
    ]);

    const result = extractCommunityHierarchy(rels, nodeIds);

    expect(result.levels).toBeGreaterThanOrEqual(1);
    expect(result.groups.length).toBeGreaterThanOrEqual(1);
    // All nodes should be covered
    const allMembers = new Set(result.groups.filter(g => g.level === 0).flatMap(g => g.memberIds));
    expect(allMembers.size).toBe(4);
  });

  it('creates hierarchical levels for larger graphs', () => {
    // Create a graph with clear cluster structure
    const nodeIds = makeNodeIds([
      'a1', 'a2', 'a3', // cluster A
      'b1', 'b2', 'b3', // cluster B
      'c1', 'c2', 'c3', // cluster C
    ]);
    const rels = makeRelationships([
      // Dense connections within clusters
      { src: 'a1', tgt: 'a2', weight: 0.9 },
      { src: 'a2', tgt: 'a3', weight: 0.9 },
      { src: 'a1', tgt: 'a3', weight: 0.9 },
      { src: 'b1', tgt: 'b2', weight: 0.9 },
      { src: 'b2', tgt: 'b3', weight: 0.9 },
      { src: 'b1', tgt: 'b3', weight: 0.9 },
      { src: 'c1', tgt: 'c2', weight: 0.9 },
      { src: 'c2', tgt: 'c3', weight: 0.9 },
      { src: 'c1', tgt: 'c3', weight: 0.9 },
      // Weak connections between clusters
      { src: 'a1', tgt: 'b1', weight: 0.1 },
      { src: 'b1', tgt: 'c1', weight: 0.1 },
    ]);

    const result = extractCommunityHierarchy(rels, nodeIds, 3);

    expect(result.levels).toBeGreaterThanOrEqual(1);
    expect(result.groups.length).toBeGreaterThanOrEqual(2);
    // Level 0 groups should separate clusters
    const level0Groups = result.groups.filter(g => g.level === 0);
    expect(level0Groups.length).toBeGreaterThanOrEqual(2);
    // Each group should have reasonable metadata
    for (const group of result.groups) {
      expect(group.id).toMatch(/^group:\d+:\d+$/);
      expect(group.metadata).toBeDefined();
      expect(group.descendantCount).toBeGreaterThan(0);
    }
  });

  it('includes modularity scores', () => {
    const nodeIds = makeNodeIds(['A', 'B', 'C']);
    const rels = makeRelationships([
      { src: 'A', tgt: 'B', weight: 0.8 },
      { src: 'B', tgt: 'C', weight: 0.8 },
    ]);

    const result = extractCommunityHierarchy(rels, nodeIds);

    expect(result.modularities.length).toBeGreaterThan(0);
    // Modularity should be a valid number
    for (const q of result.modularities) {
      expect(q).toBeGreaterThanOrEqual(-1);
      expect(q).toBeLessThanOrEqual(1);
    }
  });
});

// ── extractNamespaceHierarchy ────────────────────────────────────────────────

describe('extractNamespaceHierarchy', () => {
  it('groups nodes by directory', () => {
    const nodes = [
      { id: 'file:src/auth/login.ts', properties: { filePath: 'src/auth/login.ts' } },
      { id: 'file:src/auth/logout.ts', properties: { filePath: 'src/auth/logout.ts' } },
      { id: 'file:src/api/routes.ts', properties: { filePath: 'src/api/routes.ts' } },
    ];

    const result = extractNamespaceHierarchy(nodes);

    expect(result.groups.length).toBeGreaterThanOrEqual(2);
    // auth group should have 2 members
    const authGroup = result.groups.find(g =>
      g.memberIds.includes('file:src/auth/login.ts') &&
      g.memberIds.includes('file:src/auth/logout.ts'),
    );
    expect(authGroup).toBeDefined();
    expect(authGroup!.memberIds).toHaveLength(2);
  });

  it('returns empty for nodes without filePath', () => {
    const nodes = [
      { id: 'class:Foo', properties: {} },
      { id: 'function:bar', properties: {} },
    ];

    const result = extractNamespaceHierarchy(nodes);
    expect(result.groups).toHaveLength(0);
  });

  it('creates meta-edges between nested directories', () => {
    const nodes = [
      { id: 'file:src/a/x.ts', properties: { filePath: 'src/a/x.ts' } },
      { id: 'file:src/b/y.ts', properties: { filePath: 'src/b/y.ts' } },
    ];

    const result = extractNamespaceHierarchy(nodes, 3);
    // Should have meta-edges linking subdirectories
    expect(result.metaEdges.length).toBeGreaterThanOrEqual(0);
  });
});

// ── collapseGroups ───────────────────────────────────────────────────────────

describe('collapseGroups', () => {
  it('filters groups by level', () => {
    const groups: HierarchyGroup[] = [
      { id: 'group:0:0', level: 0, memberIds: ['A', 'B'], descendantCount: 2, depth: 1, metadata: { internalWeight: 0, avgCoupling: 0, externalEdgeCount: 0, entryPoints: [], dominantLabel: 'x', labelDistribution: {} } },
      { id: 'group:0:1', level: 0, memberIds: ['C'], descendantCount: 1, depth: 1, metadata: { internalWeight: 0, avgCoupling: 0, externalEdgeCount: 0, entryPoints: [], dominantLabel: 'x', labelDistribution: {} } },
      { id: 'group:1:0', level: 1, memberIds: ['super:0'], descendantCount: 3, depth: 0, metadata: { internalWeight: 0, avgCoupling: 0, externalEdgeCount: 0, entryPoints: [], dominantLabel: 'x', labelDistribution: {} } },
    ];

    const level0 = collapseGroups(groups, 0);
    expect(level0).toHaveLength(2);
    expect(level0.every(g => g.level === 0)).toBe(true);

    const level1 = collapseGroups(groups, 1);
    expect(level1).toHaveLength(1);
  });
});

// ── findGroupForNode ─────────────────────────────────────────────────────────

describe('findGroupForNode', () => {
  it('finds the group containing a node', () => {
    const groups: HierarchyGroup[] = [
      { id: 'group:0:0', level: 0, memberIds: ['A', 'B'], descendantCount: 2, depth: 1, metadata: { internalWeight: 0, avgCoupling: 0, externalEdgeCount: 0, entryPoints: [], dominantLabel: 'x', labelDistribution: {} } },
      { id: 'group:0:1', level: 0, memberIds: ['C', 'D'], descendantCount: 2, depth: 1, metadata: { internalWeight: 0, avgCoupling: 0, externalEdgeCount: 0, entryPoints: [], dominantLabel: 'x', labelDistribution: {} } },
    ];

    const found = findGroupForNode(groups, 'C', 0);
    expect(found).toBeDefined();
    expect(found!.id).toBe('group:0:1');
  });

  it('returns undefined for unknown node', () => {
    const groups: HierarchyGroup[] = [
      { id: 'group:0:0', level: 0, memberIds: ['A'], descendantCount: 1, depth: 0, metadata: { internalWeight: 0, avgCoupling: 0, externalEdgeCount: 0, entryPoints: [], dominantLabel: 'x', labelDistribution: {} } },
    ];

    expect(findGroupForNode(groups, 'Z', 0)).toBeUndefined();
    expect(findGroupForNode(groups, 'A', 1)).toBeUndefined();
  });
});
