/**
 * Tests for the Community Detection phase — Louvain algorithm.
 */

import { describe, it, expect } from 'vitest';
import { communityPhase } from '../../../src/analysis/phases/community.js';
import type { CommunityOutput } from '../../../src/analysis/phases/community.js';
import { createPhaseContext, runPipeline, getPhaseOutput } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';
import type { GraphNode } from '../../../src/core/types.js';

function fn(id: string, name: string, filePath = 'src/test.ts'): GraphNode {
  return { id, label: 'Function', properties: { name, filePath } };
}

function callsRel(sourceId: string, targetId: string) {
  return { id: `call:${sourceId}:${targetId}`, sourceId, targetId, type: 'CALLS' as const, confidence: 1, reason: 'test' };
}

describe('Community Phase', () => {
  it('partitions connected functions into communities', async () => {
    const graph = createKnowledgeGraph();
    // Group A: a → b → c
    graph.addNode(fn('fn:A:a', 'a'));
    graph.addNode(fn('fn:A:b', 'b'));
    graph.addNode(fn('fn:A:c', 'c'));
    graph.addRelationship(callsRel('fn:A:a', 'fn:A:b'));
    graph.addRelationship(callsRel('fn:A:b', 'fn:A:c'));

    // Group B: x → y → z (isolated from A)
    graph.addNode(fn('fn:B:x', 'x'));
    graph.addNode(fn('fn:B:y', 'y'));
    graph.addNode(fn('fn:B:z', 'z'));
    graph.addRelationship(callsRel('fn:B:x', 'fn:B:y'));
    graph.addRelationship(callsRel('fn:B:y', 'fn:B:z'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([communityPhase], context);
    const out = getPhaseOutput<CommunityOutput>(context, 'community');

    expect(out.communityCount).toBeGreaterThanOrEqual(1);
    expect(out.iterations).toBeGreaterThanOrEqual(1);

    // Should have Community nodes
    const communityNodes = Array.from(graph.iterNodes()).filter((n) => n.label === 'Community');
    expect(communityNodes.length).toBeGreaterThanOrEqual(1);

    // Should have MEMBER_OF edges
    const memberEdges = Array.from(graph.iterRelationshipsByType('MEMBER_OF'));
    expect(memberEdges.length).toBeGreaterThan(0);
  });

  it('handles disconnected nodes (islands)', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:isolated:one', 'one'));
    graph.addNode(fn('fn:isolated:two', 'two'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([communityPhase], context);
    const out = getPhaseOutput<CommunityOutput>(context, 'community');

    // #252: Two isolated nodes should produce exactly 2 communities
    expect(out.communityCount).toBe(2);
  });

  it('handles empty graph', async () => {
    const graph = createKnowledgeGraph();
    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([communityPhase], context);
    const out = getPhaseOutput<CommunityOutput>(context, 'community');

    expect(out.communityCount).toBe(0);
    expect(out.modularity).toBe(0);
    expect(out.iterations).toBe(0);
  });

  it('modularity is reasonable for clustered graph', async () => {
    const graph = createKnowledgeGraph();
    // Dense cluster A
    graph.addNode(fn('fn:A:one', 'a1'));
    graph.addNode(fn('fn:A:two', 'a2'));
    graph.addNode(fn('fn:A:three', 'a3'));
    graph.addRelationship(callsRel('fn:A:one', 'fn:A:two'));
    graph.addRelationship(callsRel('fn:A:one', 'fn:A:three'));
    graph.addRelationship(callsRel('fn:A:two', 'fn:A:three'));

    // Dense cluster B
    graph.addNode(fn('fn:B:one', 'b1'));
    graph.addNode(fn('fn:B:two', 'b2'));
    graph.addNode(fn('fn:B:three', 'b3'));
    graph.addRelationship(callsRel('fn:B:one', 'fn:B:two'));
    graph.addRelationship(callsRel('fn:B:one', 'fn:B:three'));
    graph.addRelationship(callsRel('fn:B:two', 'fn:B:three'));

    // Bridge edge between clusters
    graph.addRelationship(callsRel('fn:A:one', 'fn:B:one'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([communityPhase], context);
    const out = getPhaseOutput<CommunityOutput>(context, 'community');

    // #252: Two clear clusters with one bridge edge — modularity should be positive
    expect(out.modularity).toBeGreaterThan(0.1);
  });
});
