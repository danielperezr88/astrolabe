/**
 * Tests for the Process Tracing phase — BFS call-graph traversal (#131).
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
    expect(out.totalSteps).toBe(2); // helper + format (main skipped at step 0)
    expect(out.maxPathLength).toBe(2);

    const procNodes = Array.from(graph.iterNodes()).filter((n) => n.label === 'Process');
    expect(procNodes.length).toBe(1);
    expect(procNodes[0]?.properties.stepCount).toBe(3);
    expect(procNodes[0]?.properties.processType).toBe('intra_community');

    const stepEdges = Array.from(graph.iterRelationshipsByType('STEP_IN_PROCESS'));
    expect(stepEdges.length).toBe(2); // helper + format
    // Verify each step edge connects Process -> symbol
    for (const edge of stepEdges) {
      expect(edge.sourceId).toBe(procNodes[0]?.id);
    }
  });

  it('creates ENTRY_POINT_OF edges from function to Process', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:entry', 'entry'));
    graph.addNode(fn('fn:callee', 'callee', 'src/test.ts', false));
    graph.addRelationship(callsRel('fn:entry', 'fn:callee'));

    const context = createPhaseContext('/test', graph, () => {});
    (context.state as any).resolution = {};
    await runPipeline([processTracingPhase], context);

    const entryEdges = Array.from(graph.iterRelationshipsByType('ENTRY_POINT_OF'));
    expect(entryEdges.length).toBe(1);
    expect(entryEdges[0].sourceId).toBe('fn:entry');
  });

  it('skips non-exported functions without route/tool handler scoring', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:private', 'privateFn', 'src/test.ts', false));
    graph.addNode(fn('fn:public', 'publicFn'));

    const context = createPhaseContext('/test', graph, () => {});
    (context.state as any).resolution = {};
    await runPipeline([processTracingPhase], context);
    const out = getPhaseOutput<ProcessTracingOutput>(context, 'process-tracing');

    // Private function with no callers and no route/tool handler: score < 0.5
    expect(out.processCount).toBe(0);
    expect(out.totalSteps).toBe(0);
  });

  it('handles graph with no CALLS edges', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:a', 'a'));
    graph.addNode(fn('fn:b', 'b'));

    const context = createPhaseContext('/test', graph, () => {});
    (context.state as any).resolution = {};
    await runPipeline([processTracingPhase], context);
    const out = getPhaseOutput<ProcessTracingOutput>(context, 'process-tracing');

    expect(out.processCount).toBe(0);
    expect(out.totalSteps).toBe(0);
    expect(out.maxPathLength).toBe(0);
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

  it('detects multi-factor entry points with name-based scoring', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:handleReq', 'handleRequest', 'src/routes/api.ts', true));
    graph.addNode(fn('fn:process', 'processData', 'src/test.ts', false));
    graph.addRelationship(callsRel('fn:handleReq', 'fn:process'));

    const context = createPhaseContext('/test', graph, () => {});
    (context.state as any).resolution = {};
    await runPipeline([processTracingPhase], context);
    const out = getPhaseOutput<ProcessTracingOutput>(context, 'process-tracing');

    // handleRequest scores: name +0.5, file position +0.3, export +0.3, no-callers +0.3 = enough
    expect(out.processCount).toBeGreaterThanOrEqual(1);

    // Verify entry point score was set
    const handleNode = graph.getNode('fn:handleReq');
    expect(handleNode?.properties.entryPointScore).toBeDefined();
    expect(handleNode?.properties.entryPointScore).toBeGreaterThan(0.5);
  });

  it('cleans stale Process nodes before re-run', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:a', 'a'));
    graph.addRelationship(callsRel('fn:a', 'fn:a'));
    // Add a stale Process node
    graph.addNode({ id: 'process:stale', label: 'Process', properties: { name: 'stale', stepCount: 0, processType: 'intra_community', entryPointId: '', terminalId: '' } });

    const context = createPhaseContext('/test', graph, () => {});
    (context.state as any).resolution = {};
    await runPipeline([processTracingPhase], context);

    // Stale process should be removed
    expect(graph.getNode('process:stale')).toBeUndefined();
  });
});
