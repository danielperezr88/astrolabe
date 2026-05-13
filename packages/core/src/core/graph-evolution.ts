/**
 * Temporal graph evolution — snapshots, diffs, and trend detection (#807).
 *
 * Computes per-snapshot metrics from the knowledge graph and detects
 * health-score trends over time using linear regression.
 */

import type { KnowledgeGraph } from '../core/types.js';
import { pageRank, betweennessCentrality, tarjanSCC, detectHubs, detectBridges } from './graph-algorithms.js';
import { countGraphlets, buildAdjacencyMap, scoreArchitectureHealth } from '../analysis/graphlet/index.js';
import type { CommunityInfo } from '../analysis/graphlet/index.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** Metrics captured in a single snapshot. */
export interface SnapshotData {
  id: string;
  timestamp: string;
  commitSha: string;
  branch: string;
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  modularity: number;
  avgPagerankMax: number;
  avgBetweennessMax: number;
  healthScore: number;
  cohesion: number;
  complexity: number;
  cycleCount: number;
  hubCount: number;
  unstableDepCount: number;
}

/** Trend classification over a series of snapshots. */
export type TrendDirection = 'improving' | 'degrading' | 'stable';

/** Trend result from linear regression on health scores. */
export interface TrendResult {
  direction: TrendDirection;
  slope: number;
  confidence: number;
  currentScore: number;
  projectedScore: number;
  snapshotCount: number;
}

/** Diff between two snapshots. */
export interface SnapshotDiff {
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
  healthDelta: number;
  newCycles: number;
  resolvedCycles: number;
}

// ── Build adjacency ────────────────────────────────────────────────────────

/**
 * Build a directed adjacency list from CALLS / IMPORTS / EXTENDS / IMPLEMENTS
 * edges in the graph.  Excludes synthetic edges like STEP_IN_PROCESS, MEMBER_OF.
 */
function buildAdjacencyFromGraph(graph: KnowledgeGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const skipTypes = new Set(['STEP_IN_PROCESS', 'MEMBER_OF', 'ENTRY_POINT_OF']);
  const edgeTypes = new Set(['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']);

  // Ensure every node has an entry
  for (const node of graph.iterNodes()) {
    adj.set(node.id, []);
  }

  for (const rel of graph.iterRelationships()) {
    if (skipTypes.has(rel.type)) continue;
    if (!edgeTypes.has(rel.type)) continue;

    let bucket = adj.get(rel.sourceId);
    if (!bucket) { bucket = []; adj.set(rel.sourceId, bucket); }
    bucket.push(rel.targetId);

    // Ensure target exists
    if (!adj.has(rel.targetId)) adj.set(rel.targetId, []);
  }

  return adj;
}

// ── Compute snapshot metrics ───────────────────────────────────────────────

/**
 * Compute a full snapshot data object from a loaded knowledge graph.
 *
 * Runs PageRank, betweenness centrality, Tarjan SCC, hub detection,
 * bridge detection, graphlet counting, and architecture health scoring.
 */
export function computeSnapshotMetrics(
  graph: KnowledgeGraph,
  commitSha?: string,
  branch?: string,
): SnapshotData {
  const adj = buildAdjacencyFromGraph(graph);
  const timestamp = new Date().toISOString();

  // Basic counts
  let communityCount = 0;
  for (const node of graph.iterNodes()) {
    if (node.label === 'Community') communityCount++;
  }

  // PageRank — top 5 avg
  const pr = pageRank(adj);
  const topPR = pr.slice(0, 5);
  const avgPagerankMax = topPR.length > 0
    ? topPR.reduce((s, r) => s + r.score, 0) / topPR.length
    : 0;

  // Betweenness — top 5 avg
  const bc = betweennessCentrality(adj);
  const topBC = bc.slice(0, 5);
  const avgBetweennessMax = topBC.length > 0
    ? topBC.reduce((s, r) => s + r.score, 0) / topBC.length
    : 0;

  // Cycles (SCCs of size >= 2)
  const sccs = tarjanSCC(adj);
  const cycleCount = sccs.filter((s) => s.size >= 2).length;

  // Hubs (god-module + hub classifications)
  const hubs = detectHubs(adj, 3, 3);
  const hubCount = hubs.filter((h) => h.classification === 'god-module' || h.classification === 'hub').length;

  // Unstable dependencies (Martin metrics with distance > 0.7)
  const bridges = detectBridges(adj);
  const unstableDepCount = bridges.length;

  // Graphlet-based health scoring
  const structuralLabels = new Set(['File', 'Folder', 'Import', 'Package']);
  const nodeIds = new Set<string>();
  const nodeIterable: Array<{ id: string }> = [];
  for (const node of graph.iterNodes()) {
    if (!structuralLabels.has(node.label)) {
      nodeIds.add(node.id);
      nodeIterable.push({ id: node.id });
    }
  }

  const allowedEdgeTypes = new Set(['CALLS', 'IMPORTS', 'EXTENDS']);
  const relIterable: Array<{ sourceId: string; targetId: string; type: string }> = [];
  for (const rel of graph.iterRelationships()) {
    if (allowedEdgeTypes.has(rel.type)) {
      relIterable.push({ sourceId: rel.sourceId, targetId: rel.targetId, type: rel.type });
    }
  }

  const adjMap = buildAdjacencyMap(relIterable, nodeIds);
  const profile = countGraphlets(nodeIterable, adjMap);

  // Extract community info
  const communities: CommunityInfo[] = [];
  for (const node of graph.iterNodes()) {
    if (node.label === 'Community') {
      const symbolCount = node.properties.symbolCount as number | undefined;
      if (symbolCount !== undefined && symbolCount > 0) {
        communities.push({ id: node.id, nodeCount: symbolCount });
      }
    }
  }

  const health = scoreArchitectureHealth(profile, communities, adjMap);

  return {
    id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    commitSha: commitSha ?? 'unknown',
    branch: branch ?? 'unknown',
    nodeCount: graph.nodeCount,
    edgeCount: graph.relationshipCount,
    communityCount,
    modularity: health.modularity,
    avgPagerankMax,
    avgBetweennessMax,
    healthScore: health.overallScore,
    cohesion: health.cohesion,
    complexity: health.complexity,
    cycleCount,
    hubCount,
    unstableDepCount,
  };
}

// ── Trend detection ────────────────────────────────────────────────────────

/**
 * Detect the trend of health scores over a series of snapshots using
 * simple linear regression.
 *
 * Returns the direction (improving / degrading / stable), regression
 * slope, and confidence level.
 */
export function detectTrends(snapshots: SnapshotData[]): TrendResult {
  if (snapshots.length < 2) {
    return {
      direction: 'stable',
      slope: 0,
      confidence: 0,
      currentScore: snapshots[0]?.healthScore ?? 0,
      projectedScore: snapshots[0]?.healthScore ?? 0,
      snapshotCount: snapshots.length,
    };
  }

  // Sort by timestamp ascending
  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const n = sorted.length;
  const x: number[] = sorted.map((_, i) => i);
  const y: number[] = sorted.map((s) => s.healthScore);

  // Simple linear regression: y = slope * x + intercept
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((s, xi, i) => s + xi * y[i], 0);
  const sumXX = x.reduce((s, xi) => s + xi * xi, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) {
    return {
      direction: 'stable',
      slope: 0,
      confidence: 0,
      currentScore: y[y.length - 1],
      projectedScore: y[y.length - 1],
      snapshotCount: n,
    };
  }

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  // R-squared for confidence
  const yMean = sumY / n;
  const ssTot = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
  const ssRes = y.reduce((s, yi, i) => s + (yi - (slope * x[i] + intercept)) ** 2, 0);
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  // Project next score
  const projectedScore = Math.max(0, Math.min(100, slope * n + intercept));

  let direction: TrendDirection;
  const threshold = 1; // at least 1-point slope per snapshot to count as trend
  if (Math.abs(slope) < threshold * 0.5) {
    direction = 'stable';
  } else if (slope > 0) {
    direction = 'improving';
  } else {
    direction = 'degrading';
  }

  return {
    direction,
    slope: Math.round(slope * 1000) / 1000,
    confidence: Math.round(rSquared * 100) / 100,
    currentScore: y[y.length - 1],
    projectedScore: Math.round(projectedScore * 10) / 10,
    snapshotCount: n,
  };
}
