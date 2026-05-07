/**
 * Tests for the MRO phase — C3 linearization of class hierarchies.
 */

import { describe, it, expect } from 'vitest';
import { mroPhase } from '../../../src/analysis/phases/mro.js';
import type { MroOutput } from '../../../src/analysis/phases/mro.js';
import { createPhaseContext, runPipeline, getPhaseOutput } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';
import type { GraphNode } from '../../../src/core/types.js';

function cls(id: string, name: string, filePath = 'src/test.ts'): GraphNode {
  return { id, label: 'Class', properties: { name, filePath } };
}

function fn(id: string, name: string, filePath = 'src/test.ts'): GraphNode {
  return { id, label: 'Function', properties: { name, filePath } };
}

function meth(id: string, name: string, filePath = 'src/test.ts', parentClass?: string): GraphNode {
  return { id, label: 'Method', properties: { name, filePath, ...(parentClass ? { parentClass } : {}) } };
}

function extendsRel(sourceId: string, targetId: string) {
  return { id: `ext:${sourceId}:${targetId}`, sourceId, targetId, type: 'EXTENDS' as const, confidence: 1, reason: 'test' };
}

describe('MRO Phase', () => {
  it('handles single class with no parents', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(cls('class:A', 'A'));
    graph.addNode(fn('fn:A:foo', 'foo'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([mroPhase], context);
    const out = getPhaseOutput<MroOutput>(context, 'mro');

    expect(out.classCount).toBe(1);
    expect(out.extendsEdgeCount).toBe(0);
    expect(out.maxDepth).toBe(0);
    expect(out.methodEdgeCount).toBe(0);
  });

  it('computes C3 linearization for single inheritance', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(cls('class:A', 'A'));
    graph.addNode(cls('class:B', 'B'));
    graph.addNode(meth('meth:A:do', 'do', 'src/a.ts'));
    graph.addNode(meth('meth:B:run', 'run', 'src/b.ts'));
    graph.addRelationship(extendsRel('class:B', 'class:A'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([mroPhase], context);
    const out = getPhaseOutput<MroOutput>(context, 'mro');

    expect(out.classCount).toBe(2);
    expect(out.extendsEdgeCount).toBe(1);
    const bNode = graph.getNode('class:B');
    expect(bNode?.properties.mro).toBeDefined();
    expect(bNode?.properties.mroDepth).toBe(1);
  });

  it('handles diamond inheritance (diamond problem)', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(cls('class:A', 'A'));    // root
    graph.addNode(cls('class:B', 'B'));
    graph.addNode(cls('class:C', 'C'));
    graph.addNode(cls('class:D', 'D'));    // leaf
    graph.addRelationship(extendsRel('class:B', 'class:A'));
    graph.addRelationship(extendsRel('class:C', 'class:A'));
    graph.addRelationship(extendsRel('class:D', 'class:B'));
    graph.addRelationship(extendsRel('class:D', 'class:C'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([mroPhase], context);
    const out = getPhaseOutput<MroOutput>(context, 'mro');

    expect(out.classCount).toBe(4);
    expect(out.extendsEdgeCount).toBe(4);

    const dNode = graph.getNode('class:D');
    const mro = dNode?.properties.mro as string[];
    expect(mro).toBeDefined();
    expect(mro[0]).toBe('class:D');
    // A should be an ancestor in the MRO (not necessarily last)
    expect(mro).toContain('class:A');
  });

  it('handles empty graph', async () => {
    const graph = createKnowledgeGraph();
    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([mroPhase], context);
    const out = getPhaseOutput<MroOutput>(context, 'mro');

    expect(out.classCount).toBe(0);
    expect(out.maxDepth).toBe(0);
  });

  it('creates HAS_METHOD edges for inherited methods', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(cls('class:Base', 'Base', 'src/base.ts'));
    graph.addNode(cls('class:Child', 'Child', 'src/child.ts'));
    graph.addNode(meth('meth:Base:handle', 'handle', 'src/base.ts', 'Base'));
    graph.addRelationship(extendsRel('class:Child', 'class:Base'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([mroPhase], context);
    const out = getPhaseOutput<MroOutput>(context, 'mro');

    expect(out.methodEdgeCount).toBeGreaterThanOrEqual(1);
    expect(out.maxDepth).toBe(1);

    const hasMethodEdges = Array.from(graph.iterRelationshipsByType('HAS_METHOD'));
    expect(hasMethodEdges.length).toBeGreaterThan(0);
  });
});
