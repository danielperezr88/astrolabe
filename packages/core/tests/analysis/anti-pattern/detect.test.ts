import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../../src/core/graph.js';
import { detectAntiPatterns } from '../../../src/analysis/anti-pattern/detect.js';
import type { KnowledgeGraph, GraphNode, GraphRelationship } from '@astrolabe-dev/shared';

describe('detectAntiPatterns', () => {
  it('detects no smells in an empty graph', () => {
    const graph = createKnowledgeGraph();
    const result = detectAntiPatterns(graph);
    expect(result.sccs).toHaveLength(0);
    expect(result.hubs).toHaveLength(0);
    expect(result.meshes).toHaveLength(0);
    expect(result.bridges).toHaveLength(0);
    expect(result.cutVertices).toHaveLength(0);
  });

  it('detects a simple 2-node cycle', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'A', label: 'Class', properties: { name: 'A' } });
    graph.addNode({ id: 'B', label: 'Class', properties: { name: 'B' } });
    graph.addRelationship({ id: 'r1', sourceId: 'A', targetId: 'B', type: 'CALLS', confidence: 1, reason: 'test' });
    graph.addRelationship({ id: 'r2', sourceId: 'B', targetId: 'A', type: 'CALLS', confidence: 1, reason: 'test' });
    const result = detectAntiPatterns(graph);
    expect(result.sccs.length).toBeGreaterThan(0);
  });

  it('detects a god module with high fan-in and fan-out', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'hub', label: 'Class', properties: { name: 'GodModule' } });
    for (let i = 0; i < 5; i++) {
      graph.addNode({ id: `dep${i}`, label: 'Class', properties: { name: `Dep${i}` } });
      graph.addRelationship({ id: `in${i}`, sourceId: `dep${i}`, targetId: 'hub', type: 'CALLS', confidence: 1, reason: 'test' });
      graph.addRelationship({ id: `out${i}`, sourceId: 'hub', targetId: `dep${i}`, type: 'CALLS', confidence: 1, reason: 'test' });
    }
    const result = detectAntiPatterns(graph, { fanInThreshold: 2, fanOutThreshold: 2 });
    const hubDetection = result.hubs.find(h => h.nodeId === 'hub');
    expect(hubDetection).toBeDefined();
    expect(hubDetection!.classification).toBe('god-module');
  });

  it('returns Martin metrics for nodes', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'A', label: 'Class', properties: { name: 'A' } });
    graph.addNode({ id: 'B', label: 'Class', properties: { name: 'B' } });
    graph.addRelationship({ id: 'r1', sourceId: 'A', targetId: 'B', type: 'CALLS', confidence: 1, reason: 'test' });
    const result = detectAntiPatterns(graph);
    expect(result.martinMetrics.length).toBeGreaterThan(0);
    const aMetrics = result.martinMetrics.find(m => m.nodeId === 'A');
    expect(aMetrics).toBeDefined();
  });
});
