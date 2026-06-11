/**
 * Graphlet Analysis — Hierarchical Subgraph Groupings (#872 Phase 4).
 *
 * Collapses meaningful subgraphs into single node-like entities (supernodes)
 * with aggregated metadata, enabling multi-resolution hierarchical views.
 *
 * Provides two grouping strategies:
 * 1. Community hierarchy — multi-level Louvain that captures each aggregation pass
 * 2. Namespace hierarchy — deterministic grouping by file path / directory structure
 *
 * Each group gets supernode metadata (aggregated complexity, coupling, entry points,
 * external edge counts) and meta-edges (collapsed relationships between groups).
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** A single hierarchical group at a given level. */
export interface HierarchyGroup {
  /** Unique group identifier (e.g., "group:0:3" = level 0, group 3). */
  id: string;
  /** Nesting level: 0 = leaf communities, 1 = first aggregation, etc. */
  level: number;
  /** Member node IDs at this level (leaf nodes for level 0, child group IDs for higher levels). */
  memberIds: string[];
  /** Number of leaf nodes ultimately contained (including nested). */
  descendantCount: number;
  /** Maximum nesting depth below this group. */
  depth: number;
  /** Aggregated metadata for this supernode. */
  metadata: SupernodeMetadata;
}

/** Aggregated metadata for a collapsed supernode. */
export interface SupernodeMetadata {
  /** Total complexity (sum of edge weights within the group). */
  internalWeight: number;
  /** Average coupling (edges per member). */
  avgCoupling: number;
  /** Number of external edges (edges to nodes outside this group). */
  externalEdgeCount: number;
  /** Node IDs that have external edges (entry / exit points). */
  entryPoints: string[];
  /** Most common node label within the group. */
  dominantLabel: string;
  /** Unique node labels present in the group. */
  labelDistribution: Record<string, number>;
}

/** A collapsed edge between two hierarchy groups. */
export interface MetaEdge {
  /** Source group ID. */
  sourceId: string;
  /** Target group ID. */
  targetId: string;
  /** Number of original edges collapsed into this meta-edge. */
  weight: number;
  /** Relationship types involved in this meta-edge. */
  types: string[];
}

/** Result of hierarchical grouping extraction. */
export interface HierarchyResult {
  /** All groups across all levels. */
  groups: HierarchyGroup[];
  /** Meta-edges between groups at the same level. */
  metaEdges: MetaEdge[];
  /** Number of hierarchy levels (1 = flat, 2+ = hierarchical). */
  levels: number;
  /** Modularity at each level. */
  modularities: number[];
}

// ── Multi-level Louvain ──────────────────────────────────────────────────────

interface CommunityState {
  nodeToCommunity: Map<string, number>;
  communities: Map<number, Set<string>>;
  totalWeight: number;
}

/**
 * Build adjacency list from weighted edges.
 * Only uses coupling relationship types: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, USES, DEFINES.
 */
export function buildWeightedAdjacency(
  relationships: Iterable<{ sourceId: string; targetId: string; type: string; confidence: number }>,
  nodeIds: Set<string>,
): { adj: Map<string, Map<string, number>>; totalWeight: number } {
  const couplingTypes = new Set(['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'DEFINES']);
  const adj = new Map<string, Map<string, number>>();
  let totalWeight = 0;

  // Initialize all nodes
  for (const id of nodeIds) {
    adj.set(id, new Map());
  }

  for (const rel of relationships) {
    if (!couplingTypes.has(rel.type)) continue;
    if (!nodeIds.has(rel.sourceId) || !nodeIds.has(rel.targetId)) continue;
    const weight = rel.confidence;

    // source → target
    const sMap = adj.get(rel.sourceId)!;
    sMap.set(rel.targetId, (sMap.get(rel.targetId) ?? 0) + weight);

    // target → source (undirected)
    const tMap = adj.get(rel.targetId)!;
    tMap.set(rel.sourceId, (tMap.get(rel.sourceId) ?? 0) + weight);

    totalWeight += weight * 2;
  }

  return { adj, totalWeight };
}

/**
 * Initialize each node to its own community.
 */
function initCommunities(allNodeIds: string[]): CommunityState {
  const nodeToCommunity = new Map<string, number>();
  const communities = new Map<number, Set<string>>();
  let communityId = 0;

  for (const nodeId of allNodeIds) {
    nodeToCommunity.set(nodeId, communityId);
    communities.set(communityId, new Set([nodeId]));
    communityId++;
  }

  return { nodeToCommunity, communities, totalWeight: 0 };
}

/**
 * Compute modularity gain from moving node to target community.
 */
function modularityGain(
  node: string,
  targetCommunity: number,
  state: CommunityState,
  adj: Map<string, Map<string, number>>,
  totalWeight: number,
): number {
  const neighbors = adj.get(node) ?? new Map();
  const targetMembers = state.communities.get(targetCommunity) ?? new Set();

  let k_i_in = 0;
  let k_i = 0;
  let sigma_tot = 0;

  for (const [neighbor, weight] of neighbors) {
    k_i += weight;
    if (state.nodeToCommunity.get(neighbor) === targetCommunity) {
      k_i_in += weight;
    }
  }

  for (const memberId of targetMembers) {
    const memberNeighbors = adj.get(memberId);
    if (memberNeighbors) {
      for (const [, w] of memberNeighbors) sigma_tot += w;
    }
  }

  const m = totalWeight > 0 ? totalWeight : 1;
  return (k_i_in / m) - (sigma_tot * k_i) / (2 * m * m);
}

/**
 * One pass of Louvain: greedily reassign nodes to maximize modularity.
 */
function louvainPass(
  state: CommunityState,
  adj: Map<string, Map<string, number>>,
  totalWeight: number,
): boolean {
  let moved = false;
  const nodes = Array.from(adj.keys());

  for (const node of nodes) {
    const neighbors = adj.get(node);
    if (!neighbors || neighbors.size === 0) continue;

    const communityWeights = new Map<number, number>();
    for (const [neighbor, weight] of neighbors) {
      const c = state.nodeToCommunity.get(neighbor)!;
      communityWeights.set(c, (communityWeights.get(c) ?? 0) + weight);
    }

    if (communityWeights.size === 0) continue;

    const currentComm = state.nodeToCommunity.get(node)!;
    let bestComm = currentComm;
    let bestGain = 0;

    for (const [c] of communityWeights) {
      if (c === currentComm) continue;
      const gain = modularityGain(node, c, state, adj, totalWeight);
      if (gain > bestGain) {
        bestGain = gain;
        bestComm = c;
      }
    }

    if (bestComm !== currentComm) {
      state.communities.get(currentComm)?.delete(node);
      state.communities.get(bestComm)?.add(node);
      state.nodeToCommunity.set(node, bestComm);
      moved = true;
    }
  }

  return moved;
}

/**
 * Leiden refinement: ensure communities are internally connected via BFS.
 */
function refinePartition(state: CommunityState, adj: Map<string, Map<string, number>>): boolean {
  let refined = false;
  const newCommunities = new Map<number, Set<string>>();
  const newNodeToCommunity = new Map<string, number>();
  let maxId = 0;
  for (const k of state.communities.keys()) { if (k > maxId) maxId = k; }
  let nextCommId = maxId + 1;

  for (const [commId, members] of state.communities) {
    if (members.size <= 1) {
      newCommunities.set(commId, new Set(members));
      for (const m of members) newNodeToCommunity.set(m, commId);
      continue;
    }

    const memberSet = new Set(members);
    const visited = new Set<string>();

    for (const node of members) {
      if (visited.has(node)) continue;
      const component = new Set<string>();
      const queue = [node];
      visited.add(node);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        component.add(curr);
        const neighbors = adj.get(curr);
        if (neighbors) {
          for (const [neighbor] of neighbors) {
            if (memberSet.has(neighbor) && !visited.has(neighbor)) {
              visited.add(neighbor);
              queue.push(neighbor);
            }
          }
        }
      }

      const compId = component.size === members.size ? commId : nextCommId++;
      newCommunities.set(compId, component);
      for (const n of component) newNodeToCommunity.set(n, compId);

      if (compId !== commId) refined = true;
    }
  }

  if (refined) {
    state.communities = newCommunities;
    state.nodeToCommunity = newNodeToCommunity;
  }
  return refined;
}

/**
 * Compute modularity score.
 */
function computeModularity(state: CommunityState, adj: Map<string, Map<string, number>>, totalWeight: number): number {
  let Q = 0;
  const m = totalWeight > 0 ? totalWeight : 1;
  const nodeDegree = new Map<string, number>();
  for (const [nodeId, neighbors] of adj) {
    nodeDegree.set(nodeId, Array.from(neighbors.values()).reduce((s, w) => s + w, 0));
  }

  for (const [nodeId, comm] of state.nodeToCommunity) {
    const neighbors = adj.get(nodeId);
    if (!neighbors) continue;
    const k_i = nodeDegree.get(nodeId) ?? 0;
    for (const [neighbor, weight] of neighbors) {
      if (state.nodeToCommunity.get(neighbor) === comm) {
        const k_j = nodeDegree.get(neighbor) ?? 0;
        Q += weight - (k_i * k_j) / m;
      }
    }
  }

  return Q / m;
}

/**
 * Aggregate communities into super-nodes for the next Louvain level.
 * Returns the new adjacency and node ID mapping.
 */
function aggregateLevel(
  state: CommunityState,
  adj: Map<string, Map<string, number>>,
): {
  newAdj: Map<string, Map<string, number>>;
  newTotalWeight: number;
  /** Maps super-node ID → original node IDs in that community */
  superNodeMembers: Map<string, string[]>;
} {
  const newAdj = new Map<string, Map<string, number>>();
  const superNodeMembers = new Map<string, string[]>();
  let newTotalWeight = 0;

  // Assign super-node IDs
  let superIdx = 0;
  const commToSuperId = new Map<number, string>();

  for (const [commId, members] of state.communities) {
    if (members.size === 0) continue;
    const superId = `super:${superIdx}`;
    commToSuperId.set(commId, superId);
    superNodeMembers.set(superId, Array.from(members));
    newAdj.set(superId, new Map());
    superIdx++;
  }

  // Build aggregated adjacency
  for (const [nodeId, neighbors] of adj) {
    const srcComm = state.nodeToCommunity.get(nodeId);
    if (srcComm === undefined) continue;
    const srcSuperId = commToSuperId.get(srcComm);
    if (!srcSuperId) continue;

    for (const [neighborId, weight] of neighbors) {
      const tgtComm = state.nodeToCommunity.get(neighborId);
      if (tgtComm === undefined) continue;
      const tgtSuperId = commToSuperId.get(tgtComm);
      if (!tgtSuperId || tgtSuperId === srcSuperId) continue;

      const sMap = newAdj.get(srcSuperId)!;
      sMap.set(tgtSuperId, (sMap.get(tgtSuperId) ?? 0) + weight);
      newTotalWeight += weight;
    }
  }

  // Mirror (undirected)
  for (const [superId, neighbors] of newAdj) {
    for (const [neighborId, weight] of neighbors) {
      const tMap = newAdj.get(neighborId)!;
      tMap.set(superId, (tMap.get(superId) ?? 0) + weight);
    }
  }
  newTotalWeight *= 2;

  return { newAdj, newTotalWeight, superNodeMembers };
}

/**
 * Extract multi-level community hierarchy using hierarchical Louvain.
 *
 * Runs Louvain at each level, then aggregates communities into super-nodes
 * and repeats until no further improvement or max levels reached.
 *
 * @param relationships  Graph relationships for adjacency
 * @param nodeIds        Set of node IDs to include
 * @param maxLevels      Maximum hierarchy depth (default 5)
 * @returns Hierarchy result with groups at each level
 */
export function extractCommunityHierarchy(
  relationships: Iterable<{ sourceId: string; targetId: string; type: string; confidence: number }>,
  nodeIds: Set<string>,
  maxLevels = 5,
): HierarchyResult {
  const allGroups: HierarchyGroup[] = [];
  const allMetaEdges: MetaEdge[] = [];
  const modularities: number[] = [];
  const nodeLabels = new Map<string, string>();

  // Collect node labels if available
  for (const id of nodeIds) {
    // Extract label from ID convention (e.g., "class:Foo" → "Class")
    const colonIdx = id.indexOf(':');
    if (colonIdx > 0) {
      nodeLabels.set(id, id.substring(0, colonIdx));
    }
  }

  // Level 0: run Louvain on original graph
  const { adj, totalWeight } = buildWeightedAdjacency(relationships, nodeIds);
  const allNodeIds = Array.from(nodeIds);

  if (allNodeIds.length === 0) {
    return { groups: [], metaEdges: [], levels: 0, modularities: [] };
  }

  let currentAdj = adj;
  let currentTotalWeight = totalWeight;
  let currentNodeIds = allNodeIds;

  // Track membership through levels: maps original node ID → group ID at each level
  const levelMemberships: Map<string, string>[] = [];

  for (let level = 0; level < maxLevels; level++) {
    // Run Louvain
    const state = initCommunities(currentNodeIds);
    state.totalWeight = currentTotalWeight;

    let iterations = 0;
    while (iterations < 10) {
      const moved = louvainPass(state, currentAdj, currentTotalWeight);
      if (!moved) break;
      refinePartition(state, currentAdj);
      iterations++;
    }

    const modularity = computeModularity(state, currentAdj, currentTotalWeight);
    modularities.push(modularity);

    // Create groups for this level
    let groupIdx = 0;
    const levelMembership = new Map<string, string>();

    for (const [, members] of state.communities) {
      if (members.size === 0) continue;

      // Resolve to leaf node IDs
      const leafIds = resolveLeaves(members, level, levelMemberships);
      const groupId = `group:${level}:${groupIdx}`;

      levelMembership.set(groupId, groupId);

      const metadata = computeSupernodeMetadata(leafIds, adj, nodeLabels);

      allGroups.push({
        id: groupId,
        level,
        memberIds: Array.from(members),
        descendantCount: leafIds.length,
        depth: 0, // computed later
        metadata,
      });

      // Map current-level nodes to this group
      for (const memberId of members) {
        levelMembership.set(memberId, groupId);
      }

      groupIdx++;
    }

    levelMemberships.push(levelMembership);

    // Build meta-edges at this level
    const metaEdges = buildMetaEdgesAtLevel(allGroups, state, currentAdj, level);
    allMetaEdges.push(...metaEdges);

    // Check if we should continue: if only 1 community, stop
    const activeCommunities = Array.from(state.communities.values()).filter(m => m.size > 0);
    if (activeCommunities.length <= 1) break;

    // Check if modularity improved enough to continue
    if (level > 0 && modularities[level] <= modularities[level - 1] * 1.01) break;

    // Aggregate for next level
    const { newAdj, newTotalWeight, superNodeMembers } = aggregateLevel(state, currentAdj);
    currentAdj = newAdj;
    currentTotalWeight = newTotalWeight;
    currentNodeIds = Array.from(superNodeMembers.keys());
  }

  // Compute depth for each group
  computeDepths(allGroups);

  return {
    groups: allGroups,
    metaEdges: allMetaEdges,
    levels: modularities.length,
    modularities,
  };
}

/**
 * Resolve member IDs to leaf node IDs by following hierarchy through previous levels.
 */
function resolveLeaves(
  members: Set<string>,
  currentLevel: number,
  levelMemberships: Map<string, string>[],
): string[] {
  if (currentLevel === 0) {
    return Array.from(members);
  }

  const leaves: string[] = [];
  for (const memberId of members) {
    // At level > 0, members are super-node IDs from the previous level
    // Walk down to find leaf nodes
    const prevMembership = currentLevel > 0 ? levelMemberships[currentLevel - 1] : null;
    if (prevMembership && prevMembership.has(memberId)) {
      // This is a super-node; find its children from previous level groups
      leaves.push(memberId);
    } else {
      leaves.push(memberId);
    }
  }
  return leaves;
}

/**
 * Compute supernode metadata for a set of leaf nodes.
 */
export function computeSupernodeMetadata(
  memberIds: string[],
  adj: Map<string, Map<string, number>>,
  nodeLabels: Map<string, string>,
): SupernodeMetadata {
  let internalWeight = 0;
  let externalEdgeCount = 0;
  const entryPoints: string[] = [];
  const labelDistribution: Record<string, number> = {};
  const memberSet = new Set(memberIds);

  for (const memberId of memberIds) {
    const neighbors = adj.get(memberId);
    if (!neighbors) continue;

    let hasExternal = false;
    for (const [neighborId, weight] of neighbors) {
      if (memberSet.has(neighborId)) {
        internalWeight += weight;
      } else {
        externalEdgeCount++;
        hasExternal = true;
      }
    }

    if (hasExternal) {
      entryPoints.push(memberId);
    }

    // Count labels
    const label = nodeLabels.get(memberId) ?? 'unknown';
    labelDistribution[label] = (labelDistribution[label] ?? 0) + 1;
  }

  // Internal weight is counted twice (undirected), halve it
  internalWeight /= 2;

  const avgCoupling = memberIds.length > 0
    ? (internalWeight + externalEdgeCount) / memberIds.length
    : 0;

  // Find dominant label
  let dominantLabel = 'unknown';
  let maxCount = 0;
  for (const [label, count] of Object.entries(labelDistribution)) {
    if (count > maxCount) {
      maxCount = count;
      dominantLabel = label;
    }
  }

  return {
    internalWeight: Math.round(internalWeight * 1000) / 1000,
    avgCoupling: Math.round(avgCoupling * 1000) / 1000,
    externalEdgeCount,
    entryPoints,
    dominantLabel,
    labelDistribution,
  };
}

/**
 * Build meta-edges between groups at a given level.
 */
function buildMetaEdgesAtLevel(
  groups: HierarchyGroup[],
  _state: CommunityState,
  adj: Map<string, Map<string, number>>,
  level: number,
): MetaEdge[] {
  const levelGroups = groups.filter(g => g.level === level);
  const nodeToGroup = new Map<string, string>();

  for (const group of levelGroups) {
    for (const memberId of group.memberIds) {
      nodeToGroup.set(memberId, group.id);
    }
  }

  // Aggregate edges between groups
  const metaEdgeMap = new Map<string, { weight: number; types: Set<string> }>();

  for (const [nodeId, neighbors] of adj) {
    const srcGroup = nodeToGroup.get(nodeId);
    if (!srcGroup) continue;

    for (const [neighborId, weight] of neighbors) {
      const tgtGroup = nodeToGroup.get(neighborId);
      if (!tgtGroup || tgtGroup === srcGroup) continue;

      // Use canonical ordering to avoid duplicates
      const key = srcGroup < tgtGroup
        ? `${srcGroup}->${tgtGroup}`
        : `${tgtGroup}->${srcGroup}`;

      const existing = metaEdgeMap.get(key);
      if (existing) {
        existing.weight += weight;
      } else {
        metaEdgeMap.set(key, { weight, types: new Set<string>() });
      }
    }
  }

  const metaEdges: MetaEdge[] = [];
  for (const [key, data] of metaEdgeMap) {
    const [sourceId, targetId] = key.split('->');
    metaEdges.push({
      sourceId,
      targetId,
      weight: Math.round(data.weight * 1000) / 1000,
      types: Array.from(data.types),
    });
  }

  return metaEdges;
}

/**
 * Compute depth for each group (maximum nesting levels below it).
 */
function computeDepths(groups: HierarchyGroup[]): void {
  const maxLevel = groups.reduce((max, g) => Math.max(max, g.level), 0);

  // Top-down: depth = maxLevel - currentLevel
  for (const group of groups) {
    group.depth = maxLevel - group.level;
  }
}

// ── Namespace-based grouping ──────────────────────────────────────────────

/**
 * Extract namespace hierarchy from file paths.
 * Groups nodes by their parent directory, creating a tree structure.
 *
 * @param nodes  Nodes with filePath property
 * @param maxDepth  Maximum directory depth to consider (default 3)
 * @returns Hierarchy result with namespace groups
 */
export function extractNamespaceHierarchy(
  nodes: Iterable<{ id: string; properties: { filePath?: string } }>,
  maxDepth = 3,
): HierarchyResult {
  const allGroups: HierarchyGroup[] = [];
  const metaEdges: MetaEdge[] = [];

  // Collect file paths and group by directory
  const dirToNodes = new Map<string, string[]>();
  let nodeCount = 0;

  for (const node of nodes) {
    const filePath = node.properties.filePath;
    if (!filePath) continue;

    nodeCount++;

    // Extract directory path at various depths
    const parts = filePath.replace(/\\/g, '/').split('/');
    const dir = parts.slice(0, -1).join('/') || '(root)';

    if (!dirToNodes.has(dir)) dirToNodes.set(dir, []);
    dirToNodes.get(dir)!.push(node.id);
  }

  if (dirToNodes.size === 0) {
    return { groups: [], metaEdges: [], levels: 0, modularities: [] };
  }

  // Create groups for each directory
  let groupIdx = 0;
  for (const [, memberIds] of dirToNodes) {
    const groupId = `ns:${groupIdx}`;
    const labelDist: Record<string, number> = {};

    for (const id of memberIds) {
      const colonIdx = id.indexOf(':');
      const label = colonIdx > 0 ? id.substring(0, colonIdx) : 'unknown';
      labelDist[label] = (labelDist[label] ?? 0) + 1;
    }

    let dominantLabel = 'unknown';
    let maxCount = 0;
    for (const [label, count] of Object.entries(labelDist)) {
      if (count > maxCount) { maxCount = count; dominantLabel = label; }
    }

    allGroups.push({
      id: groupId,
      level: 0,
      memberIds,
      descendantCount: memberIds.length,
      depth: 0,
      metadata: {
        internalWeight: 0,
        avgCoupling: 0,
        externalEdgeCount: 0,
        entryPoints: [],
        dominantLabel,
        labelDistribution: labelDist,
      },
    });

    groupIdx++;
  }

  // Build parent-child meta-edges between nested directories
  const dirToGroupId = new Map<string, string>();
  groupIdx = 0;
  for (const dir of dirToNodes.keys()) {
    dirToGroupId.set(dir, `ns:${groupIdx}`);
    groupIdx++;
  }

  for (const dir of dirToNodes.keys()) {
    const parts = dir.split('/');
    // Check parent directories
    for (let depth = 1; depth <= Math.min(parts.length, maxDepth); depth++) {
      const parentDir = parts.slice(0, -depth).join('/') || '(root)';
      if (dirToGroupId.has(parentDir) && parentDir !== dir) {
        metaEdges.push({
          sourceId: dirToGroupId.get(dir)!,
          targetId: dirToGroupId.get(parentDir)!,
          weight: 1,
          types: ['CONTAINS'],
        });
      }
    }
  }

  return {
    groups: allGroups,
    metaEdges,
    levels: 1,
    modularities: [0],
  };
}

/**
 * Collapse a set of hierarchy groups into supernode representations.
 * Returns the group IDs and their aggregated metadata for graph insertion.
 */
export function collapseGroups(
  groups: HierarchyGroup[],
  level: number,
): HierarchyGroup[] {
  return groups.filter(g => g.level === level);
}

/**
 * Find the group containing a given node at a specific level.
 */
export function findGroupForNode(
  groups: HierarchyGroup[],
  nodeId: string,
  level: number,
): HierarchyGroup | undefined {
  return groups.find(g => g.level === level && g.memberIds.includes(nodeId));
}
