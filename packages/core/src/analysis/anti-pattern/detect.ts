/**
 * Architecture anti-pattern detection for Astrolabe.
 *
 * Provides `detectAntiPatterns` which builds a `CALLS` / `IMPORTS`
 * adjacency list from a KnowledgeGraph and runs the full architecture-smells
 * analysis (Tarjan SCC, hub detection, Martin metrics, mesh detection,
 * bridge edge detection, cut-vertex detection).
 */

import { architectureSmells, type ArchitectureSmellsResult } from '../../core/graph-algorithms.js';
import type { KnowledgeGraph } from '@astrolabe-dev/shared';

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Detect architecture anti-patterns in a KnowledgeGraph.
 *
 * Builds a `CALLS` + `IMPORTS` adjacency list (skipping
 * `STEP_IN_PROCESS`, `MEMBER_OF`, `ENTRY_POINT_OF` edges) and feeds it
 * through the graph-algorithms architectureSmells orchestrator.
 *
 * @param graph   Populated knowledge graph.
 * @param options Optional thresholds forwarded to the underlying detectors.
 * @returns Aggregated architecture smells report with raw graph node IDs.
 */
export function detectAntiPatterns(
  graph: KnowledgeGraph,
  options?: {
    fanInThreshold?: number;
    fanOutThreshold?: number;
    densityThreshold?: number;
  },
): ArchitectureSmellsResult {
  const adjList = new Map<string, string[]>();

  // Seed every node so the algorithm sees it
  for (const node of graph.iterNodes()) {
    if (!adjList.has(node.id)) adjList.set(node.id, []);
  }

  for (const rel of graph.iterRelationships()) {
    // Skip non-dependency edges
    if (rel.type === 'STEP_IN_PROCESS' || rel.type === 'MEMBER_OF' || rel.type === 'ENTRY_POINT_OF') continue;
    if (rel.type !== 'CALLS' && rel.type !== 'IMPORTS') continue;

    let targets = adjList.get(rel.sourceId);
    if (!targets) {
      targets = [];
      adjList.set(rel.sourceId, targets);
    }
    targets.push(rel.targetId);

    // Ensure target has an entry too
    if (!adjList.has(rel.targetId)) {
      adjList.set(rel.targetId, []);
    }
  }

  return architectureSmells(adjList, options);
}

// ── Re-exports ──────────────────────────────────────────────────────────────

export type {
  ArchitectureSmellsResult,
  SccResult,
  CutVertexResult,
  BridgeResult,
  HubResult,
  MartinMetricsResult,
  MeshResult,
} from '../../core/graph-algorithms.js';
