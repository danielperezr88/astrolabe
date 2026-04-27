/**
 * Pipeline Phase: Process Tracing
 *
 * Identifies execution entry points and traces call paths through
 * the knowledge graph using BFS traversal. Produces Process nodes
 * with STEP_IN_PROCESS edges encoding ordered execution flow.
 *
 * Entry point heuristic:
 * - Exported functions (candidates)
 * - Public methods on exported classes
 * - Functions with no incoming CALLS edges (roots)
 */

import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProcessTracingOutput {
  processCount: number;
  totalSteps: number;
  maxPathLength: number;
}

interface BfsNode {
  id: string;
  depth: number;
  parent: string | null;
}

// ── Graph helpers ───────────────────────────────────────────────────────────

/**
 * Build outgoing call graph: Map<callerId, calleeId[]>
 */
function buildCallGraph(graph: PhaseContext['graph']): Map<string, string[]> {
  const calls = new Map<string, string[]>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    let callees = calls.get(rel.sourceId);
    if (!callees) { callees = []; calls.set(rel.sourceId, callees); }
    callees.push(rel.targetId);
  }
  return calls;
}

/**
 * Find callers: Map<calleeId, callerId[]>
 */
function buildCallers(callGraph: Map<string, string[]>): Map<string, string[]> {
  const callers = new Map<string, string[]>();
  for (const [caller, callees] of callGraph) {
    for (const callee of callees) {
      let c = callers.get(callee);
      if (!c) { c = []; callers.set(callee, c); }
      c.push(caller);
    }
  }
  return callers;
}

/**
 * Identify entry points: nodes with no incoming CALLS edges
 * that are exported functions or public methods.
 */
function findEntryPoints(
  graph: PhaseContext['graph'],
  callers: Map<string, string[]>,
): string[] {
  const entries: string[] = [];

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Function' && node.label !== 'Method') continue;
    if (!node.properties.isExported) continue;

    // Entry point: no callers, or only called from test files
    const incoming = callers.get(node.id);
    if (!incoming || incoming.length === 0) {
      entries.push(node.id);
    }
  }

  return entries;
}

/**
 * BFS traversal from an entry point through the call graph.
 * Returns ordered list of nodes visited, with depth and parent info.
 */
function bfsTrace(
  entryId: string,
  callGraph: Map<string, string[]>,
  maxDepth: number,
): BfsNode[] {
  const visited = new Set<string>();
  const queue: BfsNode[] = [{ id: entryId, depth: 0, parent: null }];
  const result: BfsNode[] = [];
  visited.add(entryId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    if (current.depth >= maxDepth) continue;

    const callees = callGraph.get(current.id) ?? [];
    for (const callee of callees) {
      if (visited.has(callee)) continue;
      visited.add(callee);
      queue.push({ id: callee, depth: current.depth + 1, parent: current.id });
    }
  }

  return result;
}

// ── Phase definition ────────────────────────────────────────────────────────

export const processTracingPhase: PhaseDefinition<ProcessTracingOutput> = {
  name: 'process-tracing',
  dependencies: ['resolution'],

  execute(context: PhaseContext): ProcessTracingOutput {
    const { graph } = context;

    const callGraph = buildCallGraph(graph);
    const callers = buildCallers(callGraph);
    const entryPoints = findEntryPoints(graph, callers);

    let processCount = 0;
    let totalSteps = 0;
    let maxPathLength = 0;

    const MAX_DEPTH = 50; // Prevent infinite loops from cycles

    for (const entryId of entryPoints) {
      const trace = bfsTrace(entryId, callGraph, MAX_DEPTH);
      if (trace.length <= 1) continue; // No downstream calls

      processCount++;
      const processId = `process:${entryId}`;

      graph.addNode({
        id: processId,
        label: 'Process',
        properties: {
          name: `trace-${graph.getNode(entryId)?.properties.name ?? entryId}`,
          entryPointId: entryId,
          terminalId: trace[trace.length - 1]?.id,
          stepCount: trace.length,
          processType: 'intra_community' as const,
        },
      });

      // ENTRY_POINT_OF: Process → entry function
      graph.addRelationship({
        id: `entry:${processId}:${entryId}`,
        sourceId: entryId,
        targetId: processId,
        type: 'ENTRY_POINT_OF',
        confidence: 1,
        reason: `Entry point for process trace`,
      });

      // STEP_IN_PROCESS edges: Process -> each symbol in traversal order with step number (#79)
      for (const [idx, bfsNode] of trace.entries()) {
        totalSteps++;
        if (bfsNode.depth > maxPathLength) maxPathLength = bfsNode.depth;

        graph.addRelationship({
          id: `step:${processId}:step${idx}:${bfsNode.id}`,
          sourceId: processId,
          targetId: bfsNode.id,
          type: 'STEP_IN_PROCESS',
          confidence: 0.7,
          reason: `Step ${idx} in process trace from ${graph.getNode(entryId)?.properties.name ?? entryId}`,
          step: idx,
        });
      }
    }

    return {
      processCount,
      totalSteps,
      maxPathLength,
    };
  },
};
