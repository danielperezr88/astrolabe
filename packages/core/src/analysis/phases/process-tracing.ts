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
 * Multi-factor entry point detection with framework-aware scoring (#83).
 *
 * Scores each function/method on multiple dimensions:
 * - Route/Tool handler: +0.9
 * - Name-based (main/start/init/run/handle): +0.5-0.6
 * - File position (routes/handlers/commands dir): +0.3
 * - Call graph position (no callers, many callees): +0.3
 * - Export status: +0.3
 *
 * Returns node IDs sorted by score descending, filtered to > 0.5 threshold.
 */
function findEntryPoints(
  graph: PhaseContext['graph'],
  callers: Map<string, string[]>,
  callGraph: Map<string, string[]>,
): string[] {
  const candidates: Array<{ id: string; score: number }> = [];

  // Pre-collect route/tool target IDs for handler detection
  const routeTargets = new Set<string>();
  const toolTargets = new Set<string>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'HANDLES_ROUTE') routeTargets.add(rel.targetId);
    if (rel.type === 'HANDLES_TOOL') toolTargets.add(rel.targetId);
  }

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Function' && node.label !== 'Method') continue;

    let score = 0;
    const name = (node.properties.name as string) ?? '';
    const fp = (node.properties.filePath as string) ?? '';

    // Route/Tool handler: +0.9
    if (routeTargets.has(node.id) || toolTargets.has(node.id)) {
      score += 0.9;
    }

    // Name-based scoring
    if (/^(main|start|init|run)$/i.test(name)) score += 0.6;
    else if (/^(handle|process|serve|execute)/i.test(name)) score += 0.5;

    // File position: in known handler directories
    if (/routes?\b/i.test(fp) || /api\b/i.test(fp) || /handler/i.test(fp) || /command/i.test(fp)) {
      score += 0.3;
    }

    // Export status
    if (node.properties.isExported) score += 0.3;

    // Call graph position: no callers (only if call graph is non-empty) (#122)
    const incoming = callers.get(node.id);
    if (callGraph.size > 0 && (!incoming || incoming.length === 0)) score += 0.3;

    // Many outgoing calls (orchestrator pattern)
    const outgoing = callGraph.get(node.id);
    if (outgoing && outgoing.length >= 3) score += 0.2;

    if (score > 0.5) {
      candidates.push({ id: node.id, score });
      node.properties.entryPointScore = score;
      node.properties.entryPointReason = `Multi-factor score: ${score.toFixed(2)}`;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((c) => c.id);
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

    // Remove stale Process nodes and their edges from prior runs (#123)
    const staleProcesses: string[] = [];
    const staleEdges: string[] = [];
    for (const node of graph.iterNodes()) {
      if (node.label === 'Process') staleProcesses.push(node.id);
    }
    for (const rel of graph.iterRelationships()) {
      if (rel.type === 'STEP_IN_PROCESS' || rel.type === 'ENTRY_POINT_OF') staleEdges.push(rel.id);
    }
    for (const id of staleEdges) graph.removeRelationship(id);
    for (const id of staleProcesses) graph.removeNode(id);

    const callGraph = buildCallGraph(graph);
    const callers = buildCallers(callGraph);
    const entryPoints = findEntryPoints(graph, callers, callGraph);

    let processCount = 0;
    let totalSteps = 0;
    let maxPathLength = 0;

    const MAX_DEPTH = 50;

    for (const entryId of entryPoints) {
      const trace = bfsTrace(entryId, callGraph, MAX_DEPTH);
      if (trace.length <= 1) continue;

      processCount++;
      const processId = `process:${entryId}`;

      // Detect cross-community process (#124)
      const communities = new Set<string>();
      for (const step of trace) {
        for (const rel of graph.iterRelationshipsByType('MEMBER_OF')) {
          if (rel.targetId === step.id) communities.add(rel.sourceId);
        }
      }
      const processType = communities.size > 1 ? 'cross_community' as const : 'intra_community' as const;

      graph.addNode({
        id: processId,
        label: 'Process',
        properties: {
          name: `trace-${graph.getNode(entryId)?.properties.name ?? entryId}`,
          entryPointId: entryId,
          terminalId: trace[trace.length - 1]?.id,
          stepCount: trace.length,
          processType,
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

      // STEP_IN_PROCESS: Process -> each symbol, skip entry point at step 0 (#125)
      for (let idx = 1; idx < trace.length; idx++) {
        const bfsNode = trace[idx];
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
