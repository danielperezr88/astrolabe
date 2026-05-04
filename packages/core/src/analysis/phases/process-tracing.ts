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

export type ProcessType = 'intra_community' | 'cross_community';

export interface ProcessTracingOutput {
  processCount: number;
  totalSteps: number;
  maxPathLength: number;
  crossCommunityCount: number;
  intraCommunityCount: number;
}

interface BfsNode {
  id: string;
  depth: number;
  parent: string | null;
}

// ── Graph helpers ───────────────────────────────────────────────────────────

/**
 * Build outgoing call graph: Map<callerId, calleeId[]>
 *
 * Uses CALLS edges when available (tree-sitter function call detection).
 * Falls back to USES edges as an approximation (#91) — USES edges include
 * resolution-bindings (import → symbol), which serve as a reasonable
 * "references" graph when CALLS edges don't exist yet.
 */
function buildCallGraph(graph: PhaseContext['graph']): Map<string, string[]> {
  const calls = new Map<string, string[]>();

  // Try CALLS edges first (precise: actual function invocations)
  let usedCalls = false;
  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    usedCalls = true;
    let callees = calls.get(rel.sourceId);
    if (!callees) { callees = []; calls.set(rel.sourceId, callees); }
    callees.push(rel.targetId);
  }

  // #91: Fall back to USES edges when no CALLS edges exist.
  // USES edges are created by the resolution phase (import → resolved symbol)
  // and provide a directed "references" graph for process tracing.
  if (!usedCalls) {
    for (const rel of graph.iterRelationships()) {
      if (rel.type !== 'USES') continue;
      let callees = calls.get(rel.sourceId);
      if (!callees) { callees = []; calls.set(rel.sourceId, callees); }
      callees.push(rel.targetId);
    }
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

// ── Post-processing: community classification ────────────────────────────────

/**
 * Classify each Process node as `intra_community` or `cross_community`
 * based on whether its involved nodes span multiple Leiden communities.
 *
 * Involved nodes are collected from:
 * 1. ENTRY_POINT_OF edges (entry function → Process)
 * 2. STEP_IN_PROCESS edges (Process → each step symbol)
 * 3. ACCESSES edges originating from any involved node (data dependencies)
 *
 * Community membership is resolved via MEMBER_OF edges (sourceId=symbol,
 * targetId=community) created by the community detection phase.
 */
function classifyProcessCommunities(
  graph: PhaseContext['graph'],
): { crossCommunityCount: number; intraCommunityCount: number } {
  // Build node→community map from MEMBER_OF edges
  const nodeCommunity = new Map<string, string>();
  for (const rel of graph.iterRelationshipsByType('MEMBER_OF')) {
    nodeCommunity.set(rel.sourceId, rel.targetId);
  }

  // Pre-collect ACCESSES edges for O(1) lookup by source
  const accessesFrom = new Map<string, string[]>();
  for (const rel of graph.iterRelationshipsByType('ACCESSES')) {
    let targets = accessesFrom.get(rel.sourceId);
    if (!targets) { targets = []; accessesFrom.set(rel.sourceId, targets); }
    targets.push(rel.targetId);
  }

  let crossCommunityCount = 0;
  let intraCommunityCount = 0;

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Process') continue;
    const processId = node.id;

    // 1. Collect entry point and step node IDs
    const involvedNodeIds = new Set<string>();

    for (const rel of graph.iterRelationshipsByType('ENTRY_POINT_OF')) {
      if (rel.targetId === processId) involvedNodeIds.add(rel.sourceId);
    }
    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      if (rel.sourceId === processId) involvedNodeIds.add(rel.targetId);
    }

    // 2. Expand with ACCESSES targets from involved nodes
    for (const nodeId of involvedNodeIds) {
      const accessed = accessesFrom.get(nodeId);
      if (accessed) {
        for (const targetId of accessed) involvedNodeIds.add(targetId);
      }
    }

    // 3. Resolve community membership
    const communities = new Set<string>();
    for (const nodeId of involvedNodeIds) {
      const comm = nodeCommunity.get(nodeId);
      if (comm) communities.add(comm);
    }

    // 4. Classify: 0 or 1 community → intra_community, >1 → cross_community
    const processType: ProcessType = communities.size > 1 ? 'cross_community' : 'intra_community';
    node.properties.processType = processType;

    if (processType === 'cross_community') crossCommunityCount++;
    else intraCommunityCount++;
  }

  return { crossCommunityCount, intraCommunityCount };
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

      graph.addNode({
        id: processId,
        label: 'Process',
        properties: {
          name: `trace-${graph.getNode(entryId)?.properties.name ?? entryId}`,
          entryPointId: entryId,
          terminalId: trace[trace.length - 1]?.id,
          stepCount: trace.length,
          processType: 'intra_community' as ProcessType, // default; post-processing may update
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

    // Post-processing: classify processes as intra/cross community
    const { crossCommunityCount, intraCommunityCount } = classifyProcessCommunities(graph);

    return {
      processCount,
      totalSteps,
      maxPathLength,
      crossCommunityCount,
      intraCommunityCount,
    };
  },
};
