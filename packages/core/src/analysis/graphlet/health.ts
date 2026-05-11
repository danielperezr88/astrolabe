/**
 * Graphlet Analysis — Architecture health scoring (#461).
 *
 * Scores overall architecture health from graphlet profiles,
 * computing cohesion, modularity, and complexity metrics,
 * plus detecting anti-patterns like god modules and excessive coupling.
 */

import type { GraphletProfile } from './counter.js';

// #461: Architecture health assessment result
export interface ArchitectureHealth {
  /** Overall health score 0–100 */
  overallScore: number;
  /** How tightly coupled the graph is (0 = no coupling, 1 = fully coupled) */
  cohesion: number;
  /** How well-separated the modules are (0 = no separation, 1 = perfect modularity) */
  modularity: number;
  /** Graph complexity score (0 = simple, 1 = highly complex) */
  complexity: number;
  /** Detected anti-patterns */
  antiPatterns: Array<{
    name: string;
    severity: 'critical' | 'warning' | 'info';
    description: string;
    affectedNodes: string[];
  }>;
}

// #461: Community info needed for health scoring
export interface CommunityInfo {
  id: string;
  nodeCount: number;
}

/**
 * Score architecture health from graphlet profile and community structure.
 *
 * Combines graphlet motif ratios with community detection results to
 * produce an overall health score, cohesion/modularity metrics,
 * and anti-pattern detection.
 *
 * @param profile  Graphlet profile from countGraphlets()
 * @param communities  Community membership data
 * @param adjMap  Optional adjacency map for node-level anti-pattern detection
 */
// #461: Main health scoring entry point
export function scoreArchitectureHealth(
  profile: GraphletProfile,
  communities: CommunityInfo[],
  adjMap?: Map<string, Set<string>>,
): ArchitectureHealth {
  // Edge case: empty graph
  if (profile.nodeCount === 0) {
    return {
      overallScore: 100,
      cohesion: 0,
      modularity: 1,
      complexity: 0,
      antiPatterns: [],
    };
  }

  // ── Compute raw metrics ──────────────────────────────────────────────────

  const total3 = profile.motif3.empty + profile.motif3.oneEdge
    + profile.motif3.twoEdge + profile.motif3.triangle;
  const total4 = profile.motif4.chain + profile.motif4.star
    + profile.motif4.diamond + profile.motif4.cycle + profile.motif4.clique;

  // #461: Cohesion — ratio of connected motifs (triangle + twoEdge) vs total
  // Higher = more tightly coupled
  const cohesion = total3 > 0
    ? (profile.motif3.triangle * 3 + profile.motif3.twoEdge * 2) / (total3 * 3)
    : 0;

  // #461: Modularity — based on community structure and motif distribution
  // More communities with balanced sizes = better modularity
  const communityCount = communities.length;
  const avgCommunitySize = communityCount > 0
    ? communities.reduce((sum, c) => sum + c.nodeCount, 0) / communityCount
    : profile.nodeCount;
  const sizeStdDev = communityCount > 1
    ? Math.sqrt(
      communities.reduce((sum, c) => sum + (c.nodeCount - avgCommunitySize) ** 2, 0)
        / communityCount,
    )
    : 0;
  // Low size variance + more communities = better modularity
  const sizeBalance = avgCommunitySize > 0 ? 1 - Math.min(1, sizeStdDev / avgCommunitySize) : 0;
  const communityFactor = Math.min(1, communityCount / Math.max(1, Math.sqrt(profile.nodeCount)));
  const modularity = communityCount > 0
    ? (communityFactor * 0.6 + sizeBalance * 0.4)
    : (1 - cohesion) * 0.5; // fallback when no community data

  // #461: Complexity — weighted combination of clique ratio, cycle ratio, edge density
  const edgeDensity = profile.nodeCount > 1
    ? profile.edgeCount / (profile.nodeCount * (profile.nodeCount - 1) / 2)
    : 0;
  const cliqueRatio = total4 > 0 ? profile.motif4.clique / total4 : 0;
  const cycleRatio = total4 > 0 ? profile.motif4.cycle / total4 : 0;
  const complexity = Math.min(1,
    edgeDensity * 0.4 + cliqueRatio * 0.3 + cycleRatio * 0.3,
  );

  // ── Anti-pattern detection ───────────────────────────────────────────────

  const antiPatterns: ArchitectureHealth['antiPatterns'] = [];

  // #461: God module detection — nodes with degree > 20
  if (adjMap) {
    const godThreshold = 20;
    for (const [nodeId, neighbors] of adjMap) {
      if (neighbors.size > godThreshold) {
        antiPatterns.push({
          name: 'God module',
          severity: neighbors.size > 40 ? 'critical' : 'warning',
          description: `Node "${nodeId}" has ${neighbors.size} connections (threshold: ${godThreshold}). Consider splitting into smaller, focused modules.`,
          affectedNodes: [nodeId],
        });
      }
    }
  }

  // #461: Circular dependency clusters — high cycle count
  if (cycleRatio > 0.15 && total4 > 5) {
    antiPatterns.push({
      name: 'Circular dependency cluster',
      severity: cycleRatio > 0.3 ? 'critical' : 'warning',
      description: `${(cycleRatio * 100).toFixed(1)}% of 4-node motifs are cycles, indicating significant circular dependency chains.`,
      affectedNodes: [],
    });
  }

  // #461: Excessive coupling — triangle/clique ratio too high
  const triangleRatio = total3 > 0 ? profile.motif3.triangle / total3 : 0;
  if (triangleRatio > 0.3 && total3 > 10) {
    antiPatterns.push({
      name: 'Excessive coupling',
      severity: triangleRatio > 0.5 ? 'critical' : 'warning',
      description: `Triangle ratio is ${(triangleRatio * 100).toFixed(1)}% (threshold: 30%). Many modules form fully-connected triads, suggesting bidirectional dependencies.`,
      affectedNodes: [],
    });
  }

  // #461: Monolithic trend — very high clique count
  if (cliqueRatio > 0.2 && total4 > 5) {
    antiPatterns.push({
      name: 'Monolithic trend',
      severity: cliqueRatio > 0.35 ? 'critical' : 'warning',
      description: `Clique ratio is ${(cliqueRatio * 100).toFixed(1)}% (threshold: 20%). Many 4-node groups are fully interconnected, suggesting insufficient modularization.`,
      affectedNodes: [],
    });
  }

  // #461: Sparse architecture — too many disconnected triples
  const emptyRatio = total3 > 0 ? profile.motif3.empty / total3 : 0;
  if (emptyRatio > 0.5 && total3 > 10) {
    antiPatterns.push({
      name: 'Sparse architecture',
      severity: 'info',
      description: `${(emptyRatio * 100).toFixed(1)}% of triples are disconnected. Modules may be under-utilizing internal APIs or the graph has many isolated components.`,
      affectedNodes: [],
    });
  }

  // ── Overall score ────────────────────────────────────────────────────────

  // #461: Weighted scoring: penalize high cohesion, high complexity;
  // reward high modularity. Anti-patterns reduce score.
  let rawScore = 100;

  // Penalize excessive cohesion (0–20 point penalty)
  if (cohesion > 0.5) {
    rawScore -= (cohesion - 0.5) * 40;
  }

  // Penalize complexity (0–25 point penalty)
  rawScore -= complexity * 25;

  // Reward modularity (0–20 point bonus)
  rawScore += modularity * 20;

  // Penalize anti-patterns
  for (const ap of antiPatterns) {
    switch (ap.severity) {
      case 'critical': rawScore -= 10; break;
      case 'warning': rawScore -= 5; break;
      case 'info': rawScore -= 1; break;
    }
  }

  // Clamp to 0–100
  const overallScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  return {
    overallScore,
    cohesion: Math.round(cohesion * 1000) / 1000,
    modularity: Math.round(modularity * 1000) / 1000,
    complexity: Math.round(complexity * 1000) / 1000,
    antiPatterns,
  };
}
