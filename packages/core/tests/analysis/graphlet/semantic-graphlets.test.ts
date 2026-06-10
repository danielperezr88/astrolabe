/**
 * Tests for semantic (typed) graphlet analysis (#872 Phase 3).
 *
 * Tests the typed counter, typed pattern detection, and typed health scoring.
 * These modules extend the untyped graphlet system with node-label and
 * relationship-type awareness for richer architectural analysis.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTypedAdjacencyMap,
  countTypedGraphlets,
  emptyTypedProfile,
} from '../../../src/analysis/graphlet/typed-counter.js';
import type { TypedAdjacencyMap, TypedMotifKey, TypedGraphletProfile } from '../../../src/analysis/graphlet/typed-counter.js';
import { detectTypedPatterns } from '../../../src/analysis/graphlet/typed-patterns.js';
import type { TypedArchitecturePattern, TypedMotifSummary } from '../../../src/analysis/graphlet/typed-patterns.js';
import { scoreTypedArchitectureHealth } from '../../../src/analysis/graphlet/typed-health.js';
import type { TypedArchitectureHealth, TypedAntiPattern, LabelHealthBreakdown } from '../../../src/analysis/graphlet/typed-health.js';
import type { GraphNode, GraphRelationship } from '@astrolabe-dev/shared';
import { countGraphlets, buildAdjacencyMap } from '../../../src/analysis/graphlet/counter.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeNode(id: string, label: string): GraphNode {
  return { id, label: label as GraphNode['label'], properties: { name: id } };
}

function makeRel(id: string, src: string, tgt: string, type: string, confidence = 1): GraphRelationship {
  return { id, sourceId: src, targetId: tgt, type: type as GraphRelationship['type'], confidence, reason: 'test' };
}

// ── Typed Counter Tests ──────────────────────────────────────────────────────

describe('Typed Counter', () => {
  it('builds a typed adjacency map from graph data', () => {
    const nodes = [
      makeNode('svc:A', 'Class'),
      makeNode('svc:B', 'Function'),
      makeNode('svc:C', 'Interface'),
    ];
    const rels = [
      makeRel('r1', 'svc:A', 'svc:B', 'CALLS'),
      makeRel('r2', 'svc:C', 'svc:A', 'EXTENDS'),
    ];

    const { nodeLabels, typedAdj } = buildTypedAdjacencyMap(nodes, rels);

    expect(nodeLabels.get('svc:A')).toBe('Class');
    expect(nodeLabels.get('svc:B')).toBe('Function');
    expect(nodeLabels.get('svc:C')).toBe('Interface');

    // Undirected: A→B means A maps to B and B maps to A
    expect(typedAdj.get('svc:A')?.get('svc:B')).toBeDefined();
    expect(typedAdj.get('svc:B')?.get('svc:A')).toBeDefined();
    expect(typedAdj.get('svc:C')?.get('svc:A')).toBeDefined();
  });

  it('ignores disallowed relationship types', () => {
    const nodes = [
      makeNode('n1', 'Function'),
      makeNode('n2', 'Function'),
    ];
    const rels = [
      makeRel('r1', 'n1', 'n2', 'CONTAINS'), // not in allowed set
    ];

    const { typedAdj } = buildTypedAdjacencyMap(nodes, rels);

    // n1 should have no neighbors (CONTAINS is not in TYPED_ALLOWED_REL_TYPES)
    expect(typedAdj.get('n1')?.size ?? 0).toBe(0);
    expect(typedAdj.get('n2')?.size ?? 0).toBe(0);
  });

  it('counts typed 3-node motifs', () => {
    const nodes = [
      makeNode('A', 'Class'),
      makeNode('B', 'Function'),
      makeNode('C', 'Method'),
    ];
    const rels = [
      makeRel('r1', 'A', 'B', 'CALLS'),
      makeRel('r2', 'A', 'C', 'CALLS'),
      makeRel('r3', 'B', 'C', 'CALLS'),
    ];

    const { nodeLabels, typedAdj } = buildTypedAdjacencyMap(nodes, rels);
    const profile = countTypedGraphlets(nodes, typedAdj, nodeLabels);

    expect(profile.nodeCount).toBe(3);
    expect(profile.motif3.size).toBeGreaterThan(0);
    // Should have a triangle motif with Class:Function:Method labels
    expect(profile.edgeCount).toBeGreaterThanOrEqual(3);
  });

  it('returns empty profile for graph with fewer than 3 nodes', () => {
    const nodes = [makeNode('A', 'Class'), makeNode('B', 'Function')];
    const rels = [makeRel('r1', 'A', 'B', 'CALLS')];

    const { nodeLabels, typedAdj } = buildTypedAdjacencyMap(nodes, rels);
    const profile = countTypedGraphlets(nodes, typedAdj, nodeLabels);

    expect(profile.nodeCount).toBe(2);
    expect(profile.motif3.size).toBe(0);
    expect(profile.motif4.size).toBe(0);
  });

  it('returns empty profile for empty graph', () => {
    const profile = emptyTypedProfile(0, 0, false);
    expect(profile.nodeCount).toBe(0);
    expect(profile.motif3.size).toBe(0);
    expect(profile.motif4.size).toBe(0);
  });
});

// ── Typed Pattern Detection Tests ────────────────────────────────────────────

describe('Typed Pattern Detection', () => {
  it('detects Controller-Fat when Class has many CALLS to Functions', () => {
    // Build a typed motif summary with many Class:CALLS:Function entries
    const summary: TypedMotifSummary = {
      'Class:CALLS:Function': 15,
      'Class:CALLS:Method': 8,
      'Module:IMPORTS:Module': 3,
    };

    // Use an untyped profile with high star ratio
    const untypedProfile = {
      motif3: { empty: 10, oneEdge: 20, twoEdge: 40, triangle: 30 },
      motif4: { chain: 5, star: 20, diamond: 3, cycle: 2, clique: 1 },
      nodeCount: 100,
      edgeCount: 200,
      sampled: false,
    };

    const patterns = detectTypedPatterns(summary, untypedProfile);
    const ctrlFat = patterns.find((p) => p.name === 'Controller-Fat');
    expect(ctrlFat).toBeDefined();
    expect(ctrlFat!.confidence).toBeGreaterThan(0);
    expect(ctrlFat!.typedIndicators.length).toBeGreaterThan(0);
  });

  it('detects Circular-Import when Module:IMPORTS:Module is high', () => {
    const summary: TypedMotifSummary = {
      'Module:IMPORTS:Module': 12,
      'Class:CALLS:Function': 2,
    };

    const untypedProfile = {
      motif3: { empty: 5, oneEdge: 10, twoEdge: 20, triangle: 5 },
      motif4: { chain: 2, star: 3, diamond: 2, cycle: 8, clique: 0 },
      nodeCount: 50,
      edgeCount: 80,
      sampled: false,
    };

    const patterns = detectTypedPatterns(summary, untypedProfile);
    const circularImport = patterns.find((p) => p.name === 'Circular-Import');
    expect(circularImport).toBeDefined();
    expect(circularImport!.typedIndicators).toContain('Module:IMPORTS:Module');
  });

  it('returns fallback pattern when typed data is sparse', () => {
    const summary: TypedMotifSummary = {
      'Class:CALLS:Function': 1,
    };

    const untypedProfile = {
      motif3: { empty: 50, oneEdge: 20, twoEdge: 20, triangle: 10 },
      motif4: { chain: 10, star: 5, diamond: 3, cycle: 1, clique: 0 },
      nodeCount: 100,
      edgeCount: 150,
      sampled: false,
    };

    const patterns = detectTypedPatterns(summary, untypedProfile);
    // With sparse typed data, should fall back to untyped pattern detection
    expect(patterns.length).toBeGreaterThan(0);
  });
});

// ── Typed Health Scoring Tests ────────────────────────────────────────────────

describe('Typed Health Scoring', () => {
  it('computes base health metrics from untyped profile', () => {
    const profile = {
      motif3: { empty: 20, oneEdge: 15, twoEdge: 10, triangle: 5 },
      motif4: { chain: 8, star: 4, diamond: 2, cycle: 1, clique: 0 },
      nodeCount: 50,
      edgeCount: 75,
      sampled: false,
    };
    const communities = [
      { id: 'c1', nodeCount: 20 },
      { id: 'c2', nodeCount: 30 },
    ];
    const typedSummary: Record<string, number> = {
      'Class:CALLS:Function': 5,
    };
    const nodeLabels = new Map<string, string>([
      ['n1', 'Class'],
      ['n2', 'Function'],
    ]);
    const typedAdj: Map<string, Array<{ target: string; type: string }>> = new Map([
      ['n1', [{ target: 'n2', type: 'CALLS' }]],
      ['n2', []],
    ]);

    // Signature: (profile, typedProfile, communities, adjMap?, nodeLabels?, typedAdjMap?)
    const result = scoreTypedArchitectureHealth(profile, typedSummary, communities, undefined, nodeLabels, typedAdj);

    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
    expect(result.cohesion).toBeGreaterThanOrEqual(0);
    expect(result.modularity).toBeGreaterThanOrEqual(0);
    expect(result.complexity).toBeGreaterThanOrEqual(0);
  });

  it('detects God Controller anti-pattern', () => {
    // 20 Functions calling a single Class → god controller
    const nodes: GraphNode[] = [
      makeNode('controller', 'Class'),
      ...Array.from({ length: 20 }, (_, i) => makeNode(`fn${i}`, 'Function')),
    ];
    const rels: GraphRelationship[] = Array.from({ length: 20 }, (_, i) =>
      makeRel(`r${i}`, `fn${i}`, 'controller', 'CALLS'),
    );

    const profile = {
      motif3: { empty: 10, oneEdge: 5, twoEdge: 20, triangle: 5 },
      motif4: { chain: 3, star: 10, diamond: 2, cycle: 1, clique: 0 },
      nodeCount: 21,
      edgeCount: 40,
      sampled: false,
    };
    const communities = [{ id: 'c1', nodeCount: 21 }];
    const typedSummary: Record<string, number> = {
      'Class:CALLS:Function': 20,
    };
    const { nodeLabels, typedAdj: rawTypedAdj } = buildTypedAdjacencyMap(nodes, rels);

    // Convert to the format expected by scoreTypedArchitectureHealth
    const typedAdjMap: Map<string, Array<{ target: string; type: string }>> = new Map();
    for (const [nodeId, neighbors] of rawTypedAdj) {
      const edges: Array<{ target: string; type: string }> = [];
      for (const [neighbor, relType] of neighbors) {
        edges.push({ target: neighbor, type: relType });
      }
      typedAdjMap.set(nodeId, edges);
    }

    // Signature: (profile, typedProfile, communities, adjMap?, nodeLabels?, typedAdjMap?)
    const result = scoreTypedArchitectureHealth(profile, typedSummary, communities, undefined, nodeLabels, typedAdjMap);

    const godCtrl = result.typedAntiPatterns.find((ap) => ap.name === 'God Controller');
    expect(godCtrl).toBeDefined();
    expect(godCtrl!.severity).toBe('warning');
  });

  it('computes label breakdown for node types', () => {
    const profile = {
      motif3: { empty: 10, oneEdge: 5, twoEdge: 10, triangle: 5 },
      motif4: { chain: 4, star: 2, diamond: 1, cycle: 0, clique: 0 },
      nodeCount: 10,
      edgeCount: 15,
      sampled: false,
    };
    const communities = [{ id: 'c1', nodeCount: 10 }];
    const typedSummary: Record<string, number> = {
      'Class:CALLS:Function': 3,
    };
    const nodeLabels = new Map<string, string>([
      ['n1', 'Class'],
      ['n2', 'Class'],
      ['n3', 'Function'],
      ['n4', 'Method'],
    ]);
    const typedAdj: Map<string, Array<{ target: string; type: string }>> = new Map([
      ['n1', [{ target: 'n3', type: 'CALLS' }]],
      ['n2', [{ target: 'n4', type: 'CALLS' }]],
      ['n3', []],
      ['n4', []],
    ]);

    // Signature: (profile, typedProfile, communities, adjMap?, nodeLabels?, typedAdjMap?)
    const result = scoreTypedArchitectureHealth(profile, typedSummary, communities, undefined, nodeLabels, typedAdj);

    expect(Object.keys(result.labelBreakdown).length).toBeGreaterThan(0);
    expect(result.labelBreakdown['Class']).toBeDefined();
    expect(result.labelBreakdown['Class'].nodeCount).toBe(2);
    expect(result.labelBreakdown['Function'].nodeCount).toBe(1);
  });

  it('returns empty typed anti-patterns for empty graph', () => {
    const profile = {
      motif3: { empty: 0, oneEdge: 0, twoEdge: 0, triangle: 0 },
      motif4: { chain: 0, star: 0, diamond: 0, cycle: 0, clique: 0 },
      nodeCount: 0,
      edgeCount: 0,
      sampled: false,
    };
    const communities: Array<{ id: string; nodeCount: number }> = [];
    const typedSummary: Record<string, number> = {};
    const nodeLabels = new Map<string, string>();
    const typedAdj: Map<string, Array<{ target: string; type: string }>> = new Map();

    const result = scoreTypedArchitectureHealth(profile, typedSummary, communities, undefined, nodeLabels, typedAdj);

    expect(result.typedAntiPatterns).toEqual([]);
    expect(result.overallScore).toBe(100);
  });
});