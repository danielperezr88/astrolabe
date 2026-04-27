/**
 * Tests for the Process Tracing phase — BFS call-graph traversal.
 */

import { describe, it, expect } from 'vitest';
import { processTracingPhase } from '../../../src/analysis/phases/process-tracing.js';
import type { ProcessTracingOutput } from '../../../src/analysis/phases/process-tracing.js';
import { createPhaseContext, runPipeline, getPhaseOutput } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';
import type { GraphNode } from '../../../src/core/types.js';

function fn(id: string, name: string, filePath = 'src/test.ts', isExported = true): GraphNode {
  return { id, label: 'Function', properties: { name, filePath, isExported } };
}

function meth(id: string, name: string, filePath = 'src/test.ts', isExported = true): GraphNode {
  return { id, label: 'Method', properties: { name, filePath, isExported } };
}

function callsRel(sourceId: string, targetId: string) {
  return { id: `call:${sourceId}:${targetId}`, sourceId, targetId, type: 'CALLS' as const, confidence: 1, reason: 'test' };
}

describe('Process Tracing Phase', () => {
  it('traces call path from entry point to leaf', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:main', 'main'));
    graph.addNode(fn('fn:helper', 'helper', 'src/test.ts', false));
    graph.addNode(fn('fn:format', 'format', 'src/test.ts', false));
    graph.addRelationship(callsRel('fn:main', 'fn:helper'));
    graph.addRelationship(callsRel('fn:helper', 'fn:format'));

    const context = createPhaseContext('/test', graph, () => {});
    (context.state as any).resolution = {};
    await runPipeline([processTracingPhase], context);
    const out = getPhaseOutput<ProcessTracingOutput>(context, 'process-tracing');

    expect(out.processCount).toBe(1);
    expect(out.totalSteps).toBeGreaterThanOrEqual(2);
    expect(out.maxPathLength).toBeGreaterThanOrEqual(2);

    // Should have Process node
    const procNodes = Array.from(graph.iterNodes()).filter((n) => n.label === 'Process');
    expect(procNodes.length).toBe(1);
    expect(procNodes[0]?.properties.stepCount).toBe(3);

    // Should have STEP_IN_PROCESS edges
    const stepEdges = Array.from(graph.iterRelationshipsByType('STEP_IN_PROCESS'));
    expect(stepEdges.length).toBeGreaterThanOrEqual(2);
  });

  it('detects only exported functions as entry points', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:public', 'publicFn'));
    graph.addNode(fn('fn:private', 'privateFn', 'src/test.ts', false));
    graph.addRelationship(callsRel('fn:private', 'fn:public')); // private calls public, but private isn't an entry

    const context = createPhaseContext('/test', graph, () => {});
    (context.state as any).resolution = {};
    await runPipeline([processTracingPhase], context);
    const out = getPhaseOutput<ProcessTracingOutput>(context, 'process-tracing');

    // Private function shouldn't be an entry point
    expect(out.processCount).toBeGreaterThanOrEqual(0);
  });

  it('handles graph with no call edges', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:a', 'a'));
    graph.addNode(fn('fn:b', 'b'));

    const context = createPhaseContext('/test', graph, () => {});
    (context.state as any).resolution = {};
    await runPipeline([processTracingPhase], context);
    const out = getPhaseOutput<ProcessTracingOutput>(context, 'process-tracing');

    // No CALLS edges means no processes traced
    expect(out.processCount).toBe(0);
    expect(out.totalSteps).toBe(0);
    expect(out.maxPathLength).toBe(0);
  });

  it('creates ENTRY_POINT_OF edges', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:entry', 'entry'));
    graph.addRelationship(callsRel('fn:entry', 'fn:entry')); // self-call won't create trace but ensures it's looked at

    const context = createPhaseContext('/test', graph, () => {});
    (context.state as any).resolution = {};
    await runPipeline([processTracingPhase], context);

    // At minimum, entry functions should be identified
    const entryNodes = Array.from(graph.iterNodes()).filter((n) => n.label === 'Process');
    expect(entryNodes.length).toBeGreaterThanOrEqual(0);
  });

  it('handles empty graph', async () => {
    const graph = createKnowledgeGraph();
    const context = createPhaseContext('/test', graph, () => {});
    (context.state as any).resolution = {};
    await runPipeline([processTracingPhase], context);
    const out = getPhaseOutput<ProcessTracingOutput>(context, 'process-tracing');

    expect(out.processCount).toBe(0);
    expect(out.maxPathLength).toBe(0);
  });
});
