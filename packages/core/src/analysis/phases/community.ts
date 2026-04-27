/**
 * Pipeline Phase: Community Detection
 *
 * Uses the Louvain algorithm to partition the knowledge graph into
 * functional communities of related symbols. Creates Community nodes
 * and MEMBER_OF edges connecting symbols to their communities.
 *
 * Louvain algorithm:
 * 1. Assign each node to its own community
 * 2. Greedily move nodes to neighboring communities if modularity increases
 * 3. Aggregate nodes into super-nodes and repeat
 */

import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CommunityOutput {
  communityCount: number;
  /** Map of community ID → member node count */
  communitySizes: Record<string, number>;
  modularity: number;
  iterations: number;
}

// ── Louvain algorithm ──────────────────────────────────────────────────────

interface CommunityState {
  nodeToCommunity: Map<string, number>;
  communities: Map<number, Set<string>>;
  totalWeight: number;
}

/**
 * Build adjacency list from graph relationships.
 * Only uses relationships that indicate functional coupling:
 * CALLS, IMPORTS, EXTENDS, IMPLEMENTS, USES, DEFINES.
 */
function buildAdjacency(graph: PhaseContext['graph']): {
  adj: Map<string, Map<string, number>>;
  totalWeight: number;
  allNodeIds: string[];
} {
  const adj = new Map<string, Map<string, number>>();
  const couplingTypes = new Set(['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'DEFINES']);
  let totalWeight = 0;
  const allNodeIds = new Set<string>();

  for (const node of graph.iterNodes()) {
    // Exclude structural nodes from community detection (#63)
    if (node.label === 'File' || node.label === 'Folder' || node.label === 'Import' || node.label === 'Package') continue;
    allNodeIds.add(node.id);
    if (!adj.has(node.id)) adj.set(node.id, new Map());
  }

  for (const rel of graph.iterRelationships()) {
    if (!couplingTypes.has(rel.type)) continue;
    // Skip relationships involving structural nodes (#161)
    if (!allNodeIds.has(rel.sourceId) || !allNodeIds.has(rel.targetId)) continue;
    const weight = rel.confidence;

    // source → target
    let sMap = adj.get(rel.sourceId);
    if (!sMap) { sMap = new Map(); adj.set(rel.sourceId, sMap); }
    sMap.set(rel.targetId, (sMap.get(rel.targetId) ?? 0) + weight);

    // target → source (undirected for community detection)
    let tMap = adj.get(rel.targetId);
    if (!tMap) { tMap = new Map(); adj.set(rel.targetId, tMap); }
    tMap.set(rel.sourceId, (tMap.get(rel.sourceId) ?? 0) + weight);

    totalWeight += weight * 2; // Count both directions
  }

  return { adj, totalWeight, allNodeIds: Array.from(allNodeIds) };
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

  let k_i_in = 0; // Weight of edges from node to target community
  let k_i = 0;    // Total weight of edges incident to node
  let sigma_tot = 0; // Total weight of edges incident to target community

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
  const gain = (k_i_in / m) - (sigma_tot * k_i) / (2 * m * m);
  return gain;
}

/**
 * Partition a community into internally connected sub-communities using BFS.
 * This is the Leiden refinement phase that guarantees well-connected communities.
 */
function refinePartition(
  state: CommunityState,
  adj: Map<string, Map<string, number>>,
): boolean {
  let refined = false;
  const newCommunities = new Map<number, Set<string>>();
  const newNodeToCommunity = new Map<string, number>();
  // Find max community ID safely without spread (#187)
  let maxId = 0;
  for (const k of state.communities.keys()) { if (k > maxId) maxId = k; }
  let nextCommId = maxId + 1;

  for (const [commId, members] of state.communities) {
    if (members.size <= 1) {
      newCommunities.set(commId, new Set(members));
      for (const m of members) newNodeToCommunity.set(m, commId);
      continue;
    }

    // Build subgraph for this community
    const memberSet = new Set(members);
    const visited = new Set<string>();

    for (const node of members) {
      if (visited.has(node)) continue;

      // BFS within community to find connected component
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

    // Count which communities this node's neighbors belong to
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
      // Move node to best community
      state.communities.get(currentComm)?.delete(node);
      state.communities.get(bestComm)?.add(node);
      state.nodeToCommunity.set(node, bestComm);
      moved = true;
    }
  }

  return moved;
}

/**
 * Compute final modularity score.
 */
function computeModularity(state: CommunityState, adj: Map<string, Map<string, number>>, totalWeight: number): number {
  let Q = 0;
  const m = totalWeight > 0 ? totalWeight : 1;
  // Pre-compute node degrees to avoid O(E × maxDegree) (#190)
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

// ── Phase definition ────────────────────────────────────────────────────────

export const communityPhase: PhaseDefinition<CommunityOutput> = {
  name: 'community',
  dependencies: [],

  execute(context: PhaseContext): CommunityOutput {
    const { graph } = context;

    // Remove stale Community nodes and MEMBER_OF edges from prior pipeline runs (#73)
    const staleCommunities: string[] = [];
    const staleMemberEdges: string[] = [];
    for (const node of graph.iterNodes()) {
      if (node.label === 'Community') staleCommunities.push(node.id);
    }
    for (const rel of graph.iterRelationships()) {
      if (rel.type === 'MEMBER_OF') staleMemberEdges.push(rel.id);
    }
    for (const id of staleCommunities) graph.removeNode(id);
    for (const id of staleMemberEdges) graph.removeRelationship(id);

    const { adj, totalWeight, allNodeIds } = buildAdjacency(graph);
    if (allNodeIds.length === 0) {
      return { communityCount: 0, communitySizes: {}, modularity: 0, iterations: 0 };
    }

    const state = initCommunities(allNodeIds);
    state.totalWeight = totalWeight;
    let iterations = 0;

    while (iterations < 10) {
      const moved = louvainPass(state, adj, totalWeight);
      if (!moved) break;

      // Leiden refinement: ensure communities are internally connected (#85)
      refinePartition(state, adj);

      iterations++;
    }

    const modularity = computeModularity(state, adj, totalWeight);

    // Create Community nodes and MEMBER_OF edges
    const communitySizes: Record<string, number> = {};
    let communityIndex = 0;

    for (const [, members] of state.communities) {
      if (members.size === 0) continue;
      communityIndex++;
      const communityId = `community:${communityIndex}`;

      communitySizes[communityId] = members.size;

      graph.addNode({
        id: communityId,
        label: 'Community',
        properties: {
          name: `community-${communityIndex}`,
          symbolCount: members.size,
          cohesion: 0, // Computed later
        },
      });

      for (const memberId of members) {
        graph.addRelationship({
          id: `member:${memberId}:of:${communityId}`,
          sourceId: memberId,
          targetId: communityId,
          type: 'MEMBER_OF',
          confidence: 0.7,
          reason: `Louvain community assignment (iter ${iterations})`,
        });
      }
    }

    return {
      communityCount: Object.keys(communitySizes).length,
      communitySizes,
      modularity,
      iterations,
    };
  },
};
