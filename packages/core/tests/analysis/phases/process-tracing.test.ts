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

function memberRel(sourceId: string, targetId: string) {
  return { id: `m:${sourceId}:${targetId}`, sourceId, targetId, type: 'MEMBER_OF' as const, confidence: 0.7, reason: 'test' };
}

function accessesRel(sourceId: string, targetId: string) {
  return { id: `acc:${sourceId}:${targetId}`, sourceId, targetId, type: 'ACCESSES' as const, confidence: 0.8, reason: 'test' };
}

function comm(id: string, name: string): GraphNode {
  return { id, label: 'Community', properties: { name, symbolCount: 1 } };
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
    context.state.set('output:resolution', {});
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
    context.state.set('output:resolution', {});
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
    context.state.set('output:resolution', {});
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
    context.state.set('output:resolution', {});
    await runPipeline([processTracingPhase], context);
    const out = getPhaseOutput<ProcessTracingOutput>(context, 'process-tracing');

    expect(out.processCount).toBe(0);
    expect(out.totalSteps).toBe(0);
    expect(out.maxPathLength).toBe(0);
  });

  it('handles empty graph', async () => {
    const graph = createKnowledgeGraph();
    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
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
    context.state.set('output:resolution', {});
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
    context.state.set('output:resolution', {});
    await runPipeline([processTracingPhase], context);

    // Stale process should be removed
    expect(graph.getNode('process:stale')).toBeUndefined();
  });

  it('detects cross-community processes when trace spans multiple communities (#193)', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:entry', 'handler', 'src/routes/api.ts'));
    graph.addNode(fn('fn:service', 'processData', 'src/service/data.ts'));
    graph.addRelationship(callsRel('fn:entry', 'fn:service'));

    // Create communities with MEMBER_OF edges (sourceId=symbol, targetId=community)
    graph.addNode(comm('community:1', 'routes'));
    graph.addNode(comm('community:2', 'services'));
    graph.addRelationship(memberRel('fn:entry', 'community:1'));
    graph.addRelationship(memberRel('fn:service', 'community:2'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([processTracingPhase], context);

    const procNodes = Array.from(graph.iterNodes()).filter((n) => n.label === 'Process');
    expect(procNodes.length).toBe(1);
    expect(procNodes[0]?.properties.processType).toBe('cross_community');
    expect(procNodes[0]?.properties.name).toContain('handler');
  });

  // ── Classification-specific tests (#153) ────────────────────────────────────

  it('defaults to intra_community when no MEMBER_OF edges exist', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:start', 'start'));
    graph.addNode(fn('fn:work', 'doWork', 'src/test.ts', false));
    graph.addRelationship(callsRel('fn:start', 'fn:work'));
    // No Community nodes, no MEMBER_OF edges

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([processTracingPhase], context);

    const procNodes = Array.from(graph.iterNodes()).filter((n) => n.label === 'Process');
    expect(procNodes.length).toBe(1);
    expect(procNodes[0]?.properties.processType).toBe('intra_community');
  });

  it('classifies as intra_community when all nodes belong to the same community', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:entry', 'handle', 'src/api/routes.ts'));
    graph.addNode(fn('fn:validate', 'validate', 'src/api/validate.ts', false));
    graph.addNode(fn('fn:respond', 'respond', 'src/api/respond.ts', false));
    graph.addRelationship(callsRel('fn:entry', 'fn:validate'));
    graph.addRelationship(callsRel('fn:validate', 'fn:respond'));

    // All three functions in the same community
    graph.addNode(comm('community:1', 'api'));
    graph.addRelationship(memberRel('fn:entry', 'community:1'));
    graph.addRelationship(memberRel('fn:validate', 'community:1'));
    graph.addRelationship(memberRel('fn:respond', 'community:1'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([processTracingPhase], context);

    const procNodes = Array.from(graph.iterNodes()).filter((n) => n.label === 'Process');
    expect(procNodes.length).toBe(1);
    expect(procNodes[0]?.properties.processType).toBe('intra_community');
  });

  it('classifies as cross_community when ACCESSES edge spans another community', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:handler', 'handler', 'src/routes/api.ts'));
    graph.addNode(fn('fn:logic', 'businessLogic', 'src/logic/core.ts', false));
    graph.addRelationship(callsRel('fn:handler', 'fn:logic'));

    // handler and logic in same community by MEMBER_OF
    graph.addNode(comm('community:1', 'api'));
    graph.addRelationship(memberRel('fn:handler', 'community:1'));
    graph.addRelationship(memberRel('fn:logic', 'community:1'));

    // But fn:logic ACCESSES a node in a different community
    graph.addNode(fn('fn:db', 'dbQuery', 'src/db/query.ts', false));
    graph.addNode(comm('community:2', 'data'));
    graph.addRelationship(memberRel('fn:db', 'community:2'));
    graph.addRelationship(accessesRel('fn:logic', 'fn:db'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([processTracingPhase], context);

    const procNodes = Array.from(graph.iterNodes()).filter((n) => n.label === 'Process');
    expect(procNodes.length).toBe(1);
    expect(procNodes[0]?.properties.processType).toBe('cross_community');
  });

  it('reports crossCommunityCount and intraCommunityCount in output', async () => {
    const graph = createKnowledgeGraph();
    // Intra-community process
    graph.addNode(fn('fn:local', 'runLocal', 'src/local/runner.ts'));
    graph.addNode(fn('fn:helper', 'localHelper', 'src/local/helper.ts', false));
    graph.addRelationship(callsRel('fn:local', 'fn:helper'));
    graph.addNode(comm('community:1', 'local'));
    graph.addRelationship(memberRel('fn:local', 'community:1'));
    graph.addRelationship(memberRel('fn:helper', 'community:1'));

    // Cross-community process
    graph.addNode(fn('fn:remote', 'runRemote', 'src/remote/api.ts'));
    graph.addNode(fn('fn:svc', 'remoteService', 'src/remote/service.ts', false));
    graph.addRelationship(callsRel('fn:remote', 'fn:svc'));
    graph.addNode(comm('community:2', 'remote'));
    graph.addRelationship(memberRel('fn:remote', 'community:2'));
    graph.addRelationship(memberRel('fn:svc', 'community:2'));
    // Make it cross-community: fn:svc ACCESSES something in community:1
    graph.addRelationship(accessesRel('fn:svc', 'fn:local'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([processTracingPhase], context);
    const out = getPhaseOutput<ProcessTracingOutput>(context, 'process-tracing');

    expect(out.processCount).toBe(2);
    expect(out.intraCommunityCount).toBe(1);
    expect(out.crossCommunityCount).toBe(1);
  });

  it('classifies as cross_community when trace spans three or more communities', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:entry', 'main', 'src/main.ts'));
    graph.addNode(fn('fn:svc', 'service', 'src/svc/index.ts', false));
    graph.addNode(fn('fn:db', 'database', 'src/db/index.ts', false));
    graph.addRelationship(callsRel('fn:entry', 'fn:svc'));
    graph.addRelationship(callsRel('fn:svc', 'fn:db'));

    graph.addNode(comm('community:1', 'app'));
    graph.addNode(comm('community:2', 'service'));
    graph.addNode(comm('community:3', 'data'));
    graph.addRelationship(memberRel('fn:entry', 'community:1'));
    graph.addRelationship(memberRel('fn:svc', 'community:2'));
    graph.addRelationship(memberRel('fn:db', 'community:3'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([processTracingPhase], context);

    const procNodes = Array.from(graph.iterNodes()).filter((n) => n.label === 'Process');
    expect(procNodes.length).toBe(1);
    expect(procNodes[0]?.properties.processType).toBe('cross_community');
  });

  it('treats nodes without community membership as intra_community (no community evidence)', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fn('fn:entry', 'handler', 'src/routes/api.ts'));
    graph.addNode(fn('fn:step1', 'step1', 'src/logic/a.ts', false));
    graph.addNode(fn('fn:step2', 'step2', 'src/logic/b.ts', false));
    graph.addRelationship(callsRel('fn:entry', 'fn:step1'));
    graph.addRelationship(callsRel('fn:step1', 'fn:step2'));

    // Only entry point has a community; step1 and step2 have none
    graph.addNode(comm('community:1', 'routes'));
    graph.addRelationship(memberRel('fn:entry', 'community:1'));

    const context = createPhaseContext('/test', graph, () => {});
    context.state.set('output:resolution', {});
    await runPipeline([processTracingPhase], context);

    const procNodes = Array.from(graph.iterNodes()).filter((n) => n.label === 'Process');
    expect(procNodes.length).toBe(1);
    // Only one community seen → intra_community
    expect(procNodes[0]?.properties.processType).toBe('intra_community');
  });
});
