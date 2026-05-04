/**
 * Graph traversal engine for Cypher-like queries.
 *
 * Supports multi-step graph traversals over the KnowledgeGraph:
 *   1. match → find starting nodes by label/name/id
 *   2. traverse[] → chain of edge walks (incoming/outgoing) with type/confidence filters
 *
 * Designed as a JSON-friendly API for AI agents via the `cypher` MCP tool.
 */

import type { KnowledgeGraph, GraphNode } from '@astrolabe/shared';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TraversalMatch {
  label?: string;
  name?: string;
  id?: string;
}

export interface TraversalStep {
  direction: 'incoming' | 'outgoing';
  type?: string;
  minConfidence?: number;
}

export interface TraversalQuery {
  match?: TraversalMatch;
  traverse?: TraversalStep[];
  limit?: number;
}

export interface TraversalResultItem {
  id: string;
  label: string;
  name: string;
  filePath?: string;
  startLine?: number;
}

export interface TraversalEdge {
  sourceId: string;
  targetId: string;
  type: string;
  confidence: number;
  sourceName: string;
  targetName: string;
}

export interface TraversalResult {
  nodes: TraversalResultItem[];
  edges: TraversalEdge[];
  nodeCount: number;
  edgeCount: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function nodeToItem(node: GraphNode): TraversalResultItem {
  return {
    id: node.id,
    label: node.label,
    name: (node.properties.name as string) ?? node.id,
    filePath: node.properties.filePath as string | undefined,
    startLine: node.properties.startLine as number | undefined,
  };
}

function matchNodes(graph: KnowledgeGraph, match: TraversalMatch): GraphNode[] {
  const results: GraphNode[] = [];

  for (const node of graph.iterNodes()) {
    if (match.label && node.label !== match.label) continue;
    if (match.name && node.properties.name !== match.name) continue;
    if (match.id && node.id !== match.id) continue;
    results.push(node);
  }

  return results;
}

function traverseEdges(
  graph: KnowledgeGraph,
  nodeIds: Set<string>,
  step: TraversalStep,
): { nextIds: Set<string>; edges: TraversalEdge[] } {
  const nextIds = new Set<string>();
  const edges: TraversalEdge[] = [];

  // #422: Use type index when step.type is specified — O(R_type) instead of O(R_all)
  const relIter = step.type
    ? graph.iterRelationshipsByType(step.type as any)
    : graph.iterRelationships();

  for (const rel of relIter) {
    if (step.minConfidence !== undefined && rel.confidence < step.minConfidence) continue;

    const isMatch =
      step.direction === 'outgoing'
        ? nodeIds.has(rel.sourceId)
        : nodeIds.has(rel.targetId);

    if (!isMatch) continue;

    const neighborId = step.direction === 'outgoing' ? rel.targetId : rel.sourceId;
    const sourceNode = graph.getNode(rel.sourceId);
    const targetNode = graph.getNode(rel.targetId);

    nextIds.add(neighborId);
    edges.push({
      sourceId: rel.sourceId,
      targetId: rel.targetId,
      type: rel.type,
      confidence: rel.confidence,
      sourceName: (sourceNode?.properties.name as string) ?? rel.sourceId,
      targetName: (targetNode?.properties.name as string) ?? rel.targetId,
    });
  }

  return { nextIds, edges };
}

// ── Main traversal ─────────────────────────────────────────────────────────

export function executeTraversal(
  graph: KnowledgeGraph,
  query: TraversalQuery,
): TraversalResult {
  const limit = query.limit ?? 50;

  // Step 0: Match starting nodes
  let currentIds: Set<string>;
  let matchedNodes: GraphNode[];

  if (query.match) {
    matchedNodes = matchNodes(graph, query.match);
    currentIds = new Set(matchedNodes.map((n) => n.id));
  } else {
    // No filter → start from all nodes (limited to prevent OOM)
    matchedNodes = [];
    let count = 0;
    for (const node of graph.iterNodes()) {
      matchedNodes.push(node);
      if (++count >= limit) break;
    }
    currentIds = new Set(matchedNodes.map((n) => n.id));
  }

  if (currentIds.size === 0) {
    return { nodes: [], edges: [], nodeCount: 0, edgeCount: 0 };
  }

  // Convert matched start nodes to items
  const nodeItems: TraversalResultItem[] = matchedNodes
    .slice(0, limit)
    .map(nodeToItem);
  const allEdges: TraversalEdge[] = [];

  // Step 1+: Traverse chain
  if (query.traverse && query.traverse.length > 0) {
    // #384: Track added node IDs in Set for O(1) duplicate check
    const addedIds = new Set(nodeItems.map((n) => n.id));

    for (const step of query.traverse) {
      const { nextIds, edges } = traverseEdges(graph, currentIds, step);

      // Collect edge results
      for (const edge of edges) {
        if (allEdges.length >= limit) break;
        allEdges.push(edge);
      }

      // Collect destination node items
      for (const id of nextIds) {
        if (nodeItems.length >= limit) break;
        if (addedIds.has(id)) continue;
        addedIds.add(id);
        const node = graph.getNode(id);
        if (node) {
          nodeItems.push(nodeToItem(node));
        }
      }

      currentIds = nextIds;
      if (currentIds.size === 0) break;
    }
  }

  return {
    nodes: nodeItems.slice(0, limit),
    edges: allEdges.slice(0, limit),
    nodeCount: nodeItems.length,
    edgeCount: allEdges.length,
  };
}
