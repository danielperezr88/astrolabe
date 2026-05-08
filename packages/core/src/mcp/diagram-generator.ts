/**
 * Mermaid architecture diagram generation from the knowledge graph.
 *
 * Supports four diagram types:
 * - community: Cluster subgraphs showing module boundaries with member symbols
 * - process: Execution flow diagrams from entry points through STEP_IN_PROCESS
 * - dependency: Directed graph of CALLS, IMPORTS, EXTENDS, IMPLEMENTS edges
 * - class_hierarchy: EXTENDS and IMPLEMENTS relationships between Class/Interface nodes
 */

import type { KnowledgeGraph, GraphNode, GraphRelationship, RelationshipType } from '../core/types.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type DiagramType = 'community' | 'process' | 'dependency' | 'class_hierarchy';

export interface DiagramOptions {
  type: DiagramType;
  clusterId?: string;
  processId?: string;
  maxNodes?: number;
  minConfidence?: number;
}

export interface DiagramResult {
  diagram: string;
  format: 'mermaid' | 'markdown';
  stats: {
    nodeCount: number;
    edgeCount: number;
    communityCount?: number;
    processCount?: number;
  };
}

// ── Sanitization ────────────────────────────────────────────────────────────

/**
 * Convert a node ID to a valid Mermaid identifier.
 * Mermaid node IDs can only contain alphanumeric chars, underscores, and hyphens.
 */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Escape a label for use inside Mermaid quotes.
 */
function sanitizeLabel(label: string): string {
  return label.replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\r/g, '');
}

/**
 * Get the best display name for a node (prefer name property, fall back to id).
 */
function nodeName(node: GraphNode): string {
  return (node.properties.name as string) ?? node.id;
}

/**
 * Get a short label representation for a node.
 */
function nodeLabel(node: GraphNode): string {
  const name = nodeName(node);
  // Truncate very long names for readability
  const display = name.length > 50 ? name.slice(0, 47) + '...' : name;
  return `${display}\\n[${node.label}]`;
}

// ── Edge Filtering ──────────────────────────────────────────────────────────

/** Relationship types that represent structural/coupling edges for diagrams. */
const COUPLING_EDGES: Set<RelationshipType> = new Set([
  'CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'DEFINES',
]);

const EXTENDS_IMPLEMENTS_EDGES: Set<RelationshipType> = new Set([
  'EXTENDS', 'IMPLEMENTS',
]);

/**
 * Format an edge type for display in Mermaid arrow labels.
 */
function formatEdgeType(type: RelationshipType): string {
  // Shorten common types for diagram readability
  switch (type) {
    case 'METHOD_OVERRIDES': return 'overrides';
    case 'METHOD_IMPLEMENTS': return 'implements';
    case 'MEMBER_OF': return 'member of';
    default: return type.toLowerCase().replace(/_/g, ' ');
  }
}

/**
 * Check if a relationship passes confidence threshold.
 */
function passesConfidence(rel: GraphRelationship, minConfidence: number): boolean {
  return (rel.confidence ?? 1) >= minConfidence;
}

// ── Community Cluster Diagram ───────────────────────────────────────────────

/**
 * Build a Mermaid graph showing communities as subgraphs with their member
 * symbols and the coupling edges between them.
 */
function buildCommunityDiagram(
  graph: KnowledgeGraph,
  opts: DiagramOptions,
): string {
  const lines: string[] = ['```mermaid', 'graph TD'];
  const minConf = opts.minConfidence ?? 0.5;
  const maxNodes = opts.maxNodes ?? 200;
  let nodeCount = 0;
  let edgeCount = 0;

  // Build community → member mapping
  const communityMap = new Map<string, { name: string; members: Set<string> }>();
  for (const rel of graph.iterRelationshipsByType('MEMBER_OF')) {
    if (!passesConfidence(rel, minConf)) continue;
    const community = graph.getNode(rel.targetId);
    const symbol = graph.getNode(rel.sourceId);
    if (!community || !symbol) continue;

    let entry = communityMap.get(community.id);
    if (!entry) {
      entry = {
        name: (community.properties.name as string) ?? community.id,
        members: new Set(),
      };
      communityMap.set(community.id, entry);
    }
    entry.members.add(symbol.id);
  }

  // If no communities found, do a flat diagram
  if (communityMap.size === 0) {
    lines.push('  %% No communities detected — showing flat dependency graph');
    lines.push(...buildDependencyEdges(graph, new Set(), minConf, maxNodes, { nodeCount, edgeCount }));
    lines.push('```');
    return lines.join('\n');
  }

  // If clusterId specified, filter to only that community + connected communities
  let targetCommunities: Set<string>;
  if (opts.clusterId) {
    targetCommunities = new Set<string>();
    // Find the target community by id or name
    let targetId = opts.clusterId;
    for (const [id, comm] of communityMap) {
      if (id === opts.clusterId || comm.name === opts.clusterId || id.includes(opts.clusterId)) {
        targetId = id;
        break;
      }
    }
    targetCommunities.add(targetId);

    // Also include communities that have edges to/from the target
    const targetMembers = communityMap.get(targetId)?.members ?? new Set();
    const connectedCommunities = new Set<string>();
    for (const rel of graph.iterRelationships()) {
      if (!COUPLING_EDGES.has(rel.type)) continue;
      if (!passesConfidence(rel, minConf)) continue;
      if (targetMembers.has(rel.sourceId) && !targetMembers.has(rel.targetId)) {
        // Find which community the target belongs to
        for (const [cid, comm] of communityMap) {
          if (comm.members.has(rel.targetId)) connectedCommunities.add(cid);
        }
      }
      if (targetMembers.has(rel.targetId) && !targetMembers.has(rel.sourceId)) {
        for (const [cid, comm] of communityMap) {
          if (comm.members.has(rel.sourceId)) connectedCommunities.add(cid);
        }
      }
    }
    for (const cid of connectedCommunities) targetCommunities.add(cid);
  } else {
    targetCommunities = new Set(communityMap.keys());
  }

  // Render communities as subgraphs
  const allMemberIds = new Set<string>();
  let communityIndex = 0;
  for (const [commId, comm] of communityMap) {
    if (!targetCommunities.has(commId)) continue;
    if (comm.members.size === 0) continue;
    communityIndex++;

    const commLabel = sanitizeLabel(comm.name);
    lines.push(`  subgraph cluster_${sanitizeId(commId)}["${commLabel}"]`);

    // Add member nodes (limit per community)
    let memberIdx = 0;
    for (const memberId of comm.members) {
      if (memberIdx >= Math.floor(maxNodes / communityMap.size)) break;
      const member = graph.getNode(memberId);
      if (!member) continue;
      allMemberIds.add(memberId);
      const mId = sanitizeId(memberId);
      const mLabel = sanitizeLabel(nodeLabel(member));
      lines.push(`    ${mId}["${mLabel}"]`);
      memberIdx++;
      nodeCount++;
    }
    lines.push('  end');
    lines.push('');
  }

  // Render coupling edges between members (within and across communities)
  lines.push(...buildDependencyEdges(graph, allMemberIds, minConf, maxNodes, { nodeCount, edgeCount }));
  edgeCount += lines.filter(l => !l.startsWith('subgraph') && !l.startsWith('end') && !l.startsWith('%%')).length - 2;

  lines.push('```');
  return lines.join('\n');
}

// ── Process Flow Diagram ────────────────────────────────────────────────────

function buildProcessDiagram(
  graph: KnowledgeGraph,
  opts: DiagramOptions,
): string {
  const lines: string[] = ['```mermaid', 'graph LR'];
  const minConf = opts.minConfidence ?? 0.5;
  let nodeCount = 0;
  let edgeCount = 0;

  // Find target process
  const processes: Array<{ node: GraphNode; steps: Array<{ step: number; node: GraphNode }> }> = [];

  for (const procNode of graph.iterNodes()) {
    if (procNode.label !== 'Process') continue;
    if (opts.processId && procNode.id !== opts.processId && procNode.properties.name !== opts.processId) continue;

    // Collect ordered steps
    const stepMap = new Map<number, GraphNode>();
    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      if (rel.sourceId !== procNode.id) continue;
      if (!passesConfidence(rel, minConf)) continue;
      const stepNode = graph.getNode(rel.targetId);
      if (stepNode) stepMap.set(rel.step ?? 0, stepNode);
    }

    const steps = Array.from(stepMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([step, node]) => ({ step, node }));

    if (steps.length > 0) {
      processes.push({ node: procNode, steps });
    }
  }

  if (processes.length === 0) {
    lines.push('  %% No processes found');
    lines.push('  A[No process data available]');
    lines.push('```');
    return lines.join('\n');
  }

  for (const proc of processes) {
    const procLabel = sanitizeLabel(nodeName(proc.node));
    lines.push(`  %% Process: ${procLabel} (${proc.node.properties.processType ?? 'unknown'})`);

    // Render step nodes
    const nodeIds: string[] = [];
    for (const { step: _step, node } of proc.steps) {
      const sId = sanitizeId(node.id);
      const sLabel = sanitizeLabel(nodeName(node));
      const shape = node.label === 'Function' || node.label === 'Method' ? `(["${sLabel}"])` : `["${sLabel}"]`;
      lines.push(`  ${sId}${shape}`);
      nodeIds.push(sId);
      nodeCount++;
    }

    // Render step edges (sequential flow)
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const stepNum = proc.steps[i + 1].step;
      lines.push(`  ${nodeIds[i]} -->|"step ${stepNum}"| ${nodeIds[i + 1]}`);
      edgeCount++;
    }

    // Add coupling edges between steps (CALLS, IMPORTS, etc.)
    const stepIdSet = new Set(proc.steps.map(s => s.node.id));
    for (const rel of graph.iterRelationships()) {
      if (!COUPLING_EDGES.has(rel.type)) continue;
      if (!passesConfidence(rel, minConf)) continue;
      if (stepIdSet.has(rel.sourceId) && stepIdSet.has(rel.targetId)) {
        const label = formatEdgeType(rel.type);
        lines.push(`  ${sanitizeId(rel.sourceId)} -.->|"${label}"| ${sanitizeId(rel.targetId)}`);
        edgeCount++;
      }
    }

    lines.push('');
  }

  lines.push('```');
  return lines.join('\n');
}

// ── Dependency Graph ────────────────────────────────────────────────────────

function buildDependencyEdges(
  graph: KnowledgeGraph,
  filterNodes: Set<string>,
  minConfidence: number,
  maxNodes: number,
  counters: { nodeCount: number; edgeCount: number },
): string[] {
  const lines: string[] = [];
  const edgeSet = new Set<string>(); // deduplicate by sourceId|targetId|type

  for (const rel of graph.iterRelationships()) {
    if (!COUPLING_EDGES.has(rel.type)) continue;
    if (!passesConfidence(rel, minConfidence)) continue;

    // If filtering, both source and target must be in the filter set
    if (filterNodes.size > 0) {
      if (!filterNodes.has(rel.sourceId) && !filterNodes.has(rel.targetId)) continue;
    }

    // Limit edges
    if (counters.edgeCount >= maxNodes * 3) break;

    const edgeKey = `${rel.sourceId}|${rel.targetId}|${rel.type}`;
    if (edgeSet.has(edgeKey)) continue;
    edgeSet.add(edgeKey);

    const srcId = sanitizeId(rel.sourceId);
    const tgtId = sanitizeId(rel.targetId);
    const label = formatEdgeType(rel.type);
    const style = rel.type === 'EXTENDS' || rel.type === 'IMPLEMENTS' ? '==>' : '-->';
    lines.push(`  ${srcId} ${style}|"${label}"| ${tgtId}`);
    counters.edgeCount++;
  }

  return lines;
}

function buildDependencyDiagram(
  graph: KnowledgeGraph,
  opts: DiagramOptions,
): string {
  const lines: string[] = ['```mermaid', 'graph TD'];
  const minConf = opts.minConfidence ?? 0.5;
  const maxNodes = opts.maxNodes ?? 100;
  const counters = { nodeCount: 0, edgeCount: 0 };
  const shownNodes = new Set<string>();

  // First pass: collect all nodes that participate in coupling edges
  const edgeNodes = new Set<string>();
  for (const rel of graph.iterRelationships()) {
    if (!COUPLING_EDGES.has(rel.type)) continue;
    if (!passesConfidence(rel, minConf)) continue;
    edgeNodes.add(rel.sourceId);
    edgeNodes.add(rel.targetId);
    if (edgeNodes.size >= maxNodes) break;
  }

  // Second pass: render nodes
  for (const nodeId of edgeNodes) {
    if (counters.nodeCount >= maxNodes) break;
    const node = graph.getNode(nodeId);
    if (!node) continue;
    const nId = sanitizeId(nodeId);
    const nLabel = sanitizeLabel(nodeLabel(node));
    lines.push(`  ${nId}["${nLabel}"]`);
    counters.nodeCount++;
    shownNodes.add(nodeId);
  }

  // Third pass: render edges
  const edgeLines = buildDependencyEdges(graph, shownNodes, minConf, maxNodes, counters);
  lines.push(...edgeLines);

  if (counters.nodeCount === 0) {
    lines.push('  A[No coupling edges found in graph]');
  }

  lines.push('```');
  return lines.join('\n');
}

// ── Class Hierarchy Diagram ─────────────────────────────────────────────────

function buildClassHierarchyDiagram(
  graph: KnowledgeGraph,
  opts: DiagramOptions,
): string {
  const lines: string[] = ['```mermaid', 'graph TD'];
  const minConf = opts.minConfidence ?? 0.5;
  const maxNodes = opts.maxNodes ?? 100;
  const counters = { nodeCount: 0, edgeCount: 0 };
  const shownNodes = new Set<string>();

  // Collect classes and interfaces
  const classNodes = new Map<string, GraphNode>();
  for (const node of graph.iterNodes()) {
    if (node.label === 'Class' || node.label === 'Interface') {
      classNodes.set(node.id, node);
    }
  }

  // Find EXTENDS/IMPLEMENTS edges between classes/interfaces
  const hierarchyEdges: Array<{ sourceId: string; targetId: string; type: RelationshipType }> = [];
  const edgeNodes = new Set<string>();
  for (const rel of graph.iterRelationships()) {
    if (!EXTENDS_IMPLEMENTS_EDGES.has(rel.type)) continue;
    if (!passesConfidence(rel, minConf)) continue;
    if (!classNodes.has(rel.sourceId) && !classNodes.has(rel.targetId)) continue;
    hierarchyEdges.push({ sourceId: rel.sourceId, targetId: rel.targetId, type: rel.type });
    edgeNodes.add(rel.sourceId);
    edgeNodes.add(rel.targetId);
  }

  // Also include METHOD_OVERRIDES and METHOD_IMPLEMENTS edges
  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'METHOD_OVERRIDES' && rel.type !== 'METHOD_IMPLEMENTS') continue;
    if (!passesConfidence(rel, minConf)) continue;
    hierarchyEdges.push({ sourceId: rel.sourceId, targetId: rel.targetId, type: rel.type });
    edgeNodes.add(rel.sourceId);
    edgeNodes.add(rel.targetId);
  }

  if (hierarchyEdges.length === 0) {
    lines.push('  %% No class hierarchy relationships found');
    lines.push('  A[No EXTENDS/IMPLEMENTS edges detected]');
    lines.push('```');
    return lines.join('\n');
  }

  // Render nodes (only those with hierarchy relationships)
  for (const nodeId of edgeNodes) {
    if (counters.nodeCount >= maxNodes) break;
    const node = classNodes.get(nodeId) ?? graph.getNode(nodeId);
    if (!node) continue;
    const nId = sanitizeId(nodeId);
    const nLabel = sanitizeLabel(nodeLabel(node));
    const shape = node.label === 'Interface' ? `{{"${nLabel}"}}` : `["${nLabel}"]`;
    lines.push(`  ${nId}${shape}`);
    counters.nodeCount++;
    shownNodes.add(nodeId);
  }

  // Render edges
  const edgeSet = new Set<string>();
  for (const { sourceId, targetId, type } of hierarchyEdges) {
    const key = `${sourceId}|${targetId}|${type}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);

    const srcId = sanitizeId(sourceId);
    const tgtId = sanitizeId(targetId);
    const style = type === 'EXTENDS' || type === 'IMPLEMENTS' ? '==>' : '-.->';
    lines.push(`  ${srcId} ${style}|"${formatEdgeType(type)}"| ${tgtId}`);
    counters.edgeCount++;
  }

  lines.push('```');
  return lines.join('\n');
}

// ── Main Entry Point ────────────────────────────────────────────────────────

export function generateDiagram(graph: KnowledgeGraph, opts: DiagramOptions): DiagramResult {
  let diagram: string;
  let communityCount: number | undefined;
  let processCount: number | undefined;

  // Count communities and processes for stats
  for (const node of graph.iterNodes()) {
    if (node.label === 'Community') communityCount = (communityCount ?? 0) + 1;
    if (node.label === 'Process') processCount = (processCount ?? 0) + 1;
  }

  switch (opts.type) {
    case 'community':
      diagram = buildCommunityDiagram(graph, opts);
      break;
    case 'process':
      diagram = buildProcessDiagram(graph, opts);
      break;
    case 'dependency':
      diagram = buildDependencyDiagram(graph, opts);
      break;
    case 'class_hierarchy':
      diagram = buildClassHierarchyDiagram(graph, opts);
      break;
    default:
      diagram = '```mermaid\ngraph TD\n  A[Unknown diagram type]\n```';
  }

  // Extract node/edge counts from the Mermaid output
  const nodeMatches = diagram.match(/^\s+(?!subgraph|end|%%|```)(\w+)(?:\(?)\[/gm);
  const edgeMatches = diagram.match(/^\s+\w+\s+(-->|==>|==|\.-\>|\|)/gm);
  const nodeCount = nodeMatches?.length ?? 0;
  const edgeCount = edgeMatches?.length ?? 0;

  return {
    diagram,
    format: 'mermaid',
    stats: { nodeCount, edgeCount, communityCount, processCount },
  };
}

/**
 * Wraps Mermaid diagram in markdown documentation structure.
 */
export function generateMarkdownDoc(
  graph: KnowledgeGraph,
  opts: DiagramOptions,
  repoName?: string,
): string {
  const result = generateDiagram(graph, opts);

  const typeTitles: Record<DiagramType, string> = {
    community: 'Community Architecture',
    process: 'Process Flow',
    dependency: 'Dependency Graph',
    class_hierarchy: 'Class Hierarchy',
  };

  const typeDescs: Record<DiagramType, string> = {
    community: 'Module boundaries and coupling relationships between functional communities detected by community detection.',
    process: 'Execution flow tracing from entry points through the call graph.',
    dependency: 'CALLS, IMPORTS, EXTENDS, and IMPLEMENTS relationships between code symbols.',
    class_hierarchy: 'Inheritance and implementation relationships between classes and interfaces.',
  };

  const header = repoName ? `# ${typeTitles[opts.type]} — ${repoName}` : `# ${typeTitles[opts.type]}`;
  return [
    header,
    '',
    typeDescs[opts.type],
    '',
    `**Stats**: ${result.stats.nodeCount} nodes, ${result.stats.edgeCount} edges`,
    result.stats.communityCount != null ? `- Communities: ${result.stats.communityCount}` : '',
    result.stats.processCount != null ? `- Processes: ${result.stats.processCount}` : '',
    '',
    result.diagram,
  ].filter(Boolean).join('\n');
}
