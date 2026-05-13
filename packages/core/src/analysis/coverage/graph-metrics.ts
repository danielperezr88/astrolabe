/**
 * Graph-Aware Test Coverage Metrics (#811).
 *
 * Combines coverage annotations with graph structure (communities, call edges,
 * impact scores) to produce per-community breakdowns and prioritised gap lists.
 */

import type { KnowledgeGraph } from '@astrolabe-dev/shared';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CommunityCoverage {
  communityId: string;
  communityName: string;
  totalNodes: number;
  coveredNodes: number;
  partialNodes: number;
  uncoveredNodes: number;
  nodeCoveragePercent: number;
  totalCallEdges: number;
  coveredCallEdges: number;
  edgeCoveragePercent: number;
  topGaps: Array<{ name: string; label: string; impact: number; filePath: string }>;
}

export interface GraphCoverageMetrics {
  totalFunctionNodes: number;
  coveredFunctionNodes: number;
  partialFunctionNodes: number;
  uncoveredFunctionNodes: number;
  overallNodeCoveragePercent: number;
  totalCallEdges: number;
  coveredCallEdges: number;
  overallEdgeCoveragePercent: number;
  communities: CommunityCoverage[];
  topUntestedHighImpact: Array<{ name: string; label: string; impact: number; community: string; filePath: string }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const FUNCTION_LABELS = new Set(['Function', 'Method', 'Constructor']);

interface CoverageData {
  status: 'covered' | 'partial' | 'uncovered';
  lineCoverage: number;
  functionCoverage: number;
}

function getCoverageData(node: {
  properties: Record<string, unknown>;
}): CoverageData {
  const status = node.properties._coverageStatus as string | undefined;
  const cov = node.properties._coverage as
    | { lineCoverage?: number; functionCoverage?: number }
    | undefined;

  // If no _coverageStatus, treat as uncovered
  if (!status) {
    return { status: 'uncovered', lineCoverage: 0, functionCoverage: 0 };
  }

  return {
    status: status as 'covered' | 'partial' | 'uncovered',
    lineCoverage: cov?.lineCoverage ?? 0,
    functionCoverage: cov?.functionCoverage ?? 0,
  };
}

// ── Main Algorithm ─────────────────────────────────────────────────────────

export function computeGraphCoverageMetrics(
  graph: KnowledgeGraph,
): GraphCoverageMetrics {
  // 1. Build community index from MEMBER_OF edges
  const communityOf = new Map<string, string>();
  const communityNameMap = new Map<string, string>();

  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'MEMBER_OF') {
      const communityNode = graph.getNode(rel.targetId);
      if (communityNode && communityNode.label === 'Community') {
        communityOf.set(rel.sourceId, rel.targetId);
        communityNameMap.set(
          rel.targetId,
          (communityNode.properties.name as string) ?? rel.targetId,
        );
      }
    }
  }

  // 2. Count incoming CALLS edges for impact scoring
  const incomingCallCount = new Map<string, number>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'CALLS') {
      incomingCallCount.set(
        rel.targetId,
        (incomingCallCount.get(rel.targetId) ?? 0) + 1,
      );
    }
  }

  // 3. Per-community accumulators
  interface CommunityAccum {
    totalNodes: number;
    coveredNodes: number;
    partialNodes: number;
    uncoveredNodes: number;
    totalCallEdges: number;
    coveredCallEdges: number;
    gaps: Array<{ name: string; label: string; impact: number; filePath: string }>;
  }

  const communityMap = new Map<string, CommunityAccum>();
  const ensureCommunity = (communityId: string): CommunityAccum => {
    let acc = communityMap.get(communityId);
    if (!acc) {
      acc = {
        totalNodes: 0,
        coveredNodes: 0,
        partialNodes: 0,
        uncoveredNodes: 0,
        totalCallEdges: 0,
        coveredCallEdges: 0,
        gaps: [],
      };
      communityMap.set(communityId, acc);
    }
    return acc;
  };

  // Overall accumulators
  let totalFunctionNodes = 0;
  let coveredFunctionNodes = 0;
  let partialFunctionNodes = 0;
  let uncoveredFunctionNodes = 0;

  // All function nodes for edge pass
  const fnNodeIds = new Set<string>();

  // Iterate all function-like nodes
  for (const node of graph.iterNodes()) {
    if (!FUNCTION_LABELS.has(node.label)) continue;

    const cov = getCoverageData(node);
    const commId = communityOf.get(node.id) ?? '__unassigned__';
    const acc = ensureCommunity(commId);

    fnNodeIds.add(node.id);
    totalFunctionNodes++;
    acc.totalNodes++;

    switch (cov.status) {
      case 'covered':
        coveredFunctionNodes++;
        acc.coveredNodes++;
        break;
      case 'partial':
        partialFunctionNodes++;
        acc.partialNodes++;
        break;
      case 'uncovered':
        uncoveredFunctionNodes++;
        acc.uncoveredNodes++;
        break;
    }
  }

  // 4. Count CALLS edges for edge coverage (both endpoints must be covered)
  // Also track which functions are source/target of calls for per-community edge stats
  let totalCallEdges = 0;
  let coveredCallEdges = 0;

  // Build per-community call edge maps
  const commCallEdges = new Map<string, number>(); // communityId -> total call edges
  const commCoveredCallEdges = new Map<string, number>(); // communityId -> covered call edges

  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;

    const sourceFn = fnNodeIds.has(rel.sourceId);
    const targetFn = fnNodeIds.has(rel.targetId);

    // Only count edges where both endpoints are function-like nodes
    if (!sourceFn || !targetFn) continue;

    totalCallEdges++;

    const sourceNode = graph.getNode(rel.sourceId);
    const targetNode = graph.getNode(rel.targetId);

    const sourceCov = sourceNode ? getCoverageData(sourceNode) : undefined;
    const targetCov = targetNode ? getCoverageData(targetNode) : undefined;

    const isCovered =
      sourceCov?.status === 'covered' && targetCov?.status === 'covered';
    if (isCovered) coveredCallEdges++;

    // Per-community edge stats: attribute edge to target's community
    const targetComm = communityOf.get(rel.targetId) ?? '__unassigned__';
    commCallEdges.set(targetComm, (commCallEdges.get(targetComm) ?? 0) + 1);
    if (isCovered)
      commCoveredCallEdges.set(
        targetComm,
        (commCoveredCallEdges.get(targetComm) ?? 0) + 1,
      );

    // Also attribute to source community
    const sourceComm = communityOf.get(rel.sourceId) ?? '__unassigned__';
    if (sourceComm !== targetComm) {
      commCallEdges.set(sourceComm, (commCallEdges.get(sourceComm) ?? 0) + 1);
      if (isCovered)
        commCoveredCallEdges.set(
          sourceComm,
          (commCoveredCallEdges.get(sourceComm) ?? 0) + 1,
        );
    }
  }

  // 5. Build per-community top gaps (populated below in second pass)

  // Second pass: populate gaps for uncovered nodes
  for (const node of graph.iterNodes()) {
    if (!FUNCTION_LABELS.has(node.label)) continue;

    const cov = getCoverageData(node);
    if (cov.status !== 'uncovered') continue;

    const commId = communityOf.get(node.id) ?? '__unassigned__';
    const acc = communityMap.get(commId);
    if (!acc) continue;

    const impact = incomingCallCount.get(node.id) ?? 0;

    acc.gaps.push({
      name: (node.properties.name as string) ?? node.id,
      label: node.label,
      impact,
      filePath: (node.properties.filePath as string) ?? '',
    });
  }

  // 6. Build community summaries
  const communities: CommunityCoverage[] = [];

  for (const [commId, acc] of communityMap) {
    const commName =
      commId === '__unassigned__'
        ? '(unassigned)'
        : (communityNameMap.get(commId) ?? commId);

    // Sort gaps by impact (highest first), take top 5
    acc.gaps.sort((a, b) => b.impact - a.impact);
    const topGaps = acc.gaps.slice(0, 5);

    const totalCalls = commCallEdges.get(commId) ?? 0;
    const coveredCalls = commCoveredCallEdges.get(commId) ?? 0;

    communities.push({
      communityId: commId,
      communityName: commName,
      totalNodes: acc.totalNodes,
      coveredNodes: acc.coveredNodes,
      partialNodes: acc.partialNodes,
      uncoveredNodes: acc.uncoveredNodes,
      nodeCoveragePercent:
        acc.totalNodes > 0
          ? (acc.coveredNodes / acc.totalNodes) * 100
          : 0,
      totalCallEdges: totalCalls,
      coveredCallEdges: coveredCalls,
      edgeCoveragePercent:
        totalCalls > 0 ? (coveredCalls / totalCalls) * 100 : 0,
      topGaps,
    });
  }

  // Sort communities by node coverage (worst first)
  communities.sort((a, b) => a.nodeCoveragePercent - b.nodeCoveragePercent);

  // 7. Build overall top untested high-impact
  const allGaps: Array<{
    name: string;
    label: string;
    impact: number;
    community: string;
    filePath: string;
  }> = [];

  for (const node of graph.iterNodes()) {
    if (!FUNCTION_LABELS.has(node.label)) continue;

    const cov = getCoverageData(node);
    if (cov.status !== 'uncovered') continue;

    const impact = incomingCallCount.get(node.id) ?? 0;
    const commId = communityOf.get(node.id) ?? '__unassigned__';
    const commName =
      commId === '__unassigned__'
        ? '(unassigned)'
        : (communityNameMap.get(commId) ?? commId);

    allGaps.push({
      name: (node.properties.name as string) ?? node.id,
      label: node.label,
      impact,
      community: commName,
      filePath: (node.properties.filePath as string) ?? '',
    });
  }

  allGaps.sort((a, b) => b.impact - a.impact);

  return {
    totalFunctionNodes,
    coveredFunctionNodes,
    partialFunctionNodes,
    uncoveredFunctionNodes,
    overallNodeCoveragePercent:
      totalFunctionNodes > 0
        ? (coveredFunctionNodes / totalFunctionNodes) * 100
        : 0,
    totalCallEdges,
    coveredCallEdges,
    overallEdgeCoveragePercent:
      totalCallEdges > 0 ? (coveredCallEdges / totalCallEdges) * 100 : 0,
    communities,
    topUntestedHighImpact: allGaps.slice(0, 20),
  };
}
