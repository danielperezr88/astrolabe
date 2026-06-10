/**
 * Graphlet Analysis — Typed architecture health scoring (#872).
 *
 * Extends the base architecture health scoring with typed graphlet profiles
 * for more precise anti-pattern detection using node labels and relationship
 * types (Class, Function, CALLS, EXTENDS, etc.).
 */

import type { GraphletProfile } from './counter.js';
import {
  scoreArchitectureHealth,
  type ArchitectureHealth,
  type CommunityInfo,
} from './health.js';

// #872: Summary of typed motif counts keyed by composite label strings
export type TypedMotifSummary = Record<string, number>;

// #872: Anti-pattern enriched with typed motif indicators
export interface TypedAntiPattern {
  name: string;
  severity: 'critical' | 'warning' | 'info';
  description: string;
  affectedNodes: string[];
  /** Typed motif keys that triggered this anti-pattern */
  typedIndicators: string[];
}

// #872: Per-label health breakdown entry
export interface LabelHealthBreakdown {
  nodeCount: number;
  avgDegree: number;
  /** Proportion of overall health score attributable to this label type (0–1) */
  healthContribution: number;
}

// #872: Typed architecture health result — extends base health with typed anti-patterns
export interface TypedArchitectureHealth extends ArchitectureHealth {
  /** Anti-patterns enriched with typed motif information */
  typedAntiPatterns: TypedAntiPattern[];
  /** Per-label-type health breakdown (e.g., Class cohesion, Module modularity) */
  labelBreakdown: Record<string, LabelHealthBreakdown>;
}

// #872: Edge entry in the typed adjacency map
interface TypedEdge {
  target: string;
  type: string;
}

// #872: Typed adjacency map — node ID → list of outgoing typed edges
export type TypedAdjMap = Map<string, TypedEdge[]>;

// #872: Node label map — node ID → label string
export type NodeLabelMap = Map<string, string>;

/**
 * Score architecture health using typed graphlet data.
 *
 * Computes base health metrics via {@link scoreArchitectureHealth}, then
 * enriches the result with typed anti-patterns that leverage node labels
 * (Class, Function, Method, Interface, Module) and relationship types
 * (CALLS, EXTENDS, IMPORTS, HAS_METHOD, HAS_PROPERTY) for precise detection.
 *
 * @param profile       Untyped graphlet profile from countGraphlets()
 * @param typedProfile  Typed motif summary (composite key → count)
 * @param communities   Community membership data
 * @param adjMap        Optional untyped adjacency map (for base health)
 * @param nodeLabels    Optional node ID → label mapping
 * @param typedAdjMap   Optional typed adjacency map for label-aware detection
 * @returns             Typed architecture health with enriched anti-patterns
 */
// #872: Main typed health scoring entry point
export function scoreTypedArchitectureHealth(
  profile: GraphletProfile,
  typedProfile: TypedMotifSummary,
  communities: CommunityInfo[],
  adjMap?: Map<string, Set<string>>,
  nodeLabels?: NodeLabelMap,
  typedAdjMap?: TypedAdjMap,
): TypedArchitectureHealth {
  // ── Base health (reuse existing logic) ──────────────────────────────────
  const baseHealth = scoreArchitectureHealth(profile, communities, adjMap);

  // Edge case: no typed data available
  if (!nodeLabels || nodeLabels.size === 0 || !typedAdjMap || typedAdjMap.size === 0) {
    return {
      ...baseHealth,
      typedAntiPatterns: baseHealth.antiPatterns.map((ap) => ({
        ...ap,
        typedIndicators: [],
      })),
      labelBreakdown: {},
    };
  }

  // ── Typed anti-pattern detection ────────────────────────────────────────

  const typedAntiPatterns: TypedAntiPattern[] = [];

  // #872: Build per-node degree maps keyed by edge type for efficient lookup
  const callsDegree = new Map<string, number>();
  const hasPropertyDegree = new Map<string, number>();
  const hasMethodDegree = new Map<string, number>();
  const extendsDegree = new Map<string, number>();
  const importsDegree = new Map<string, number>();

  for (const [nodeId, edges] of typedAdjMap) {
    let calls = 0;
    let hasProp = 0;
    let hasMeth = 0;
    let ext = 0;
    let imp = 0;
    for (const edge of edges) {
      switch (edge.type) {
        case 'CALLS': calls++; break;
        case 'HAS_PROPERTY': hasProp++; break;
        case 'HAS_METHOD': hasMeth++; break;
        case 'EXTENDS': ext++; break;
        case 'IMPORTS': imp++; break;
      }
    }
    if (calls > 0) callsDegree.set(nodeId, calls);
    if (hasProp > 0) hasPropertyDegree.set(nodeId, hasProp);
    if (hasMeth > 0) hasMethodDegree.set(nodeId, hasMeth);
    if (ext > 0) extendsDegree.set(nodeId, ext);
    if (imp > 0) importsDegree.set(nodeId, imp);
  }

  // ── God Controller ─────────────────────────────────────────────────────
  // Class nodes with CALLS degree > 15 to Functions/Methods

  const GOD_CONTROLLER_THRESHOLD = 15;
  for (const [nodeId, deg] of callsDegree) {
    const label = nodeLabels.get(nodeId);
    if (label === 'Class' && deg > GOD_CONTROLLER_THRESHOLD) {
      // Verify targets are Functions/Methods
      const edges = typedAdjMap.get(nodeId) ?? [];
      const targetLabels = new Set<string>();
      for (const edge of edges) {
        if (edge.type === 'CALLS') {
          const targetLabel = nodeLabels.get(edge.target);
          if (targetLabel === 'Function' || targetLabel === 'Method') {
            targetLabels.add(targetLabel);
          }
        }
      }
      if (targetLabels.size > 0) {
        typedAntiPatterns.push({
          name: 'God Controller',
          severity: deg > 30 ? 'critical' : 'warning',
          description: `Class "${nodeId}" calls ${deg} functions/methods (threshold: ${GOD_CONTROLLER_THRESHOLD}). Consider splitting responsibilities into smaller, focused classes.`,
          affectedNodes: [nodeId],
          typedIndicators: [`Class→CALLS→${deg}`, ...Array.from(targetLabels, (l) => `calls:${l}`)],
        });
      }
    }
  }

  // ── Data Class ─────────────────────────────────────────────────────────
  // Class nodes with high HAS_PROPERTY but near-zero CALLS (anemic data holders)

  const DATA_CLASS_PROPERTY_THRESHOLD = 5;
  for (const [nodeId, propDeg] of hasPropertyDegree) {
    const label = nodeLabels.get(nodeId);
    if (label === 'Class' && propDeg >= DATA_CLASS_PROPERTY_THRESHOLD) {
      const callDeg = callsDegree.get(nodeId) ?? 0;
      if (callDeg <= 1) {
        typedAntiPatterns.push({
          name: 'Data Class',
          severity: propDeg > 10 ? 'warning' : 'info',
          description: `Class "${nodeId}" has ${propDeg} properties but only ${callDeg} outgoing calls. This anemic data holder may indicate missing behavior encapsulation.`,
          affectedNodes: [nodeId],
          typedIndicators: [`Class→HAS_PROPERTY→${propDeg}`, `Class→CALLS→${callDeg}`],
        });
      }
    }
  }

  // ── Interface Bloat ────────────────────────────────────────────────────
  // Interface nodes with HAS_METHOD count > 10

  const INTERFACE_BLOAT_THRESHOLD = 10;
  for (const [nodeId, methDeg] of hasMethodDegree) {
    const label = nodeLabels.get(nodeId);
    if (label === 'Interface' && methDeg > INTERFACE_BLOAT_THRESHOLD) {
      typedAntiPatterns.push({
        name: 'Interface Bloat',
        severity: methDeg > 20 ? 'critical' : 'warning',
        description: `Interface "${nodeId}" declares ${methDeg} methods (threshold: ${INTERFACE_BLOAT_THRESHOLD}). Consider splitting into smaller, cohesive interfaces.`,
        affectedNodes: [nodeId],
        typedIndicators: [`Interface→HAS_METHOD→${methDeg}`],
      });
    }
  }

  // ── Import Cycle ───────────────────────────────────────────────────────
  // Cycle motifs where edges are IMPORTS type between Module nodes

  const importCycleKeys = Object.entries(typedProfile)
    .filter(([key, count]) => key.includes('IMPORTS') && key.includes('cycle') && count > 0);
  if (importCycleKeys.length > 0) {
    const totalCycles = importCycleKeys.reduce((sum, [, count]) => sum + count, 0);
    typedAntiPatterns.push({
      name: 'Import Cycle',
      severity: totalCycles > 5 ? 'critical' : 'warning',
      description: `Detected ${totalCycles} import cycle motif(s) between modules. Circular imports can cause initialization order issues and increase build times.`,
      affectedNodes: [],
      typedIndicators: importCycleKeys.map(([key]) => key),
    });
  }

  // ── Deep Inheritance ───────────────────────────────────────────────────
  // Chain motifs > 4 levels of EXTENDS between Class nodes

  const DEEP_INHERITANCE_DEPTH = 4;
  const extendsChainKeys = Object.entries(typedProfile)
    .filter(([key, count]) => key.includes('EXTENDS') && key.includes('chain') && count > 0);
  if (extendsChainKeys.length > 0) {
    // Walk EXTENDS chains to find nodes with depth > threshold
    const visited = new Set<string>();
    const classNodes = new Set<string>();
    for (const [nodeId, label] of nodeLabels) {
      if (label === 'Class') classNodes.add(nodeId);
    }

    for (const startNode of classNodes) {
      if (visited.has(startNode)) continue;
      const chain: string[] = [];
      let current: string | undefined = startNode;
      while (current && classNodes.has(current) && !visited.has(current)) {
        visited.add(current);
        chain.push(current);
        const edges = typedAdjMap.get(current);
        current = undefined;
        if (edges) {
          for (const edge of edges) {
            if (edge.type === 'EXTENDS' && classNodes.has(edge.target)) {
              current = edge.target;
              break;
            }
          }
        }
      }
      if (chain.length > DEEP_INHERITANCE_DEPTH) {
        typedAntiPatterns.push({
          name: 'Deep Inheritance',
          severity: chain.length > 6 ? 'critical' : 'warning',
          description: `Inheritance chain of depth ${chain.length} detected (threshold: ${DEEP_INHERITANCE_DEPTH}). Deep hierarchies increase cognitive load and fragility. Consider composition over inheritance.`,
          affectedNodes: chain,
          typedIndicators: [`Class→EXTENDS→chain:${chain.length}`],
        });
      }
    }
  }

  // ── Shotgun Surgery ────────────────────────────────────────────────────
  // High cross-community CALLS edges (functions in many communities calling each other)

  if (communities.length > 1) {
    // Infer cross-community calls from typed adjacency structure.
    // Community membership is approximated by first path component in node IDs
    // since CommunityInfo only provides aggregate node counts, not member IDs.
    let crossCommunityCalls = 0;
    let totalCalls = 0;
    for (const [nodeId, edges] of typedAdjMap) {
      const srcLabel = nodeLabels.get(nodeId);
      if (srcLabel === 'Function' || srcLabel === 'Method') {
        for (const edge of edges) {
          if (edge.type === 'CALLS') {
            totalCalls++;
            const tgtLabel = nodeLabels.get(edge.target);
            if (tgtLabel === 'Function' || tgtLabel === 'Method') {
              // Approximate cross-community: different module prefix in ID
              const srcModule = nodeId.split('/')[0] ?? nodeId;
              const tgtModule = edge.target.split('/')[0] ?? edge.target;
              if (srcModule !== tgtModule) {
                crossCommunityCalls++;
              }
            }
          }
        }
      }
    }

    const crossCommunityRatio = totalCalls > 0 ? crossCommunityCalls / totalCalls : 0;
    if (crossCommunityRatio > 0.3 && totalCalls > 20) {
      typedAntiPatterns.push({
        name: 'Shotgun Surgery',
        severity: crossCommunityRatio > 0.5 ? 'critical' : 'warning',
        description: `${(crossCommunityRatio * 100).toFixed(1)}% of function/method calls cross module boundaries (${crossCommunityCalls}/${totalCalls}). Changes to one module are likely to require changes in many others.`,
        affectedNodes: [],
        typedIndicators: [
          `cross-community-calls:${crossCommunityCalls}`,
          `calls-ratio:${crossCommunityRatio.toFixed(3)}`,
        ],
      });
    }
  }

  // ── Label breakdown ────────────────────────────────────────────────────

  const labelStats = new Map<string, { count: number; totalDegree: number }>();
  for (const [nodeId, label] of nodeLabels) {
    const existing = labelStats.get(label);
    const degree = adjMap?.get(nodeId)?.size ?? typedAdjMap.get(nodeId)?.length ?? 0;
    if (existing) {
      existing.count++;
      existing.totalDegree += degree;
    } else {
      labelStats.set(label, { count: 1, totalDegree: degree });
    }
  }

  const labelBreakdown: Record<string, LabelHealthBreakdown> = {};
  const totalLabeledNodes = Array.from(labelStats.values()).reduce((s, v) => s + v.count, 0);

  for (const [label, stats] of labelStats) {
    const avgDegree = stats.count > 0 ? stats.totalDegree / stats.count : 0;
    // Health contribution: fraction of total nodes this label represents,
    // weighted by inverse avgDegree (lower degree = healthier per-label)
    const degreePenalty = Math.min(1, avgDegree / 20); // normalize against threshold
    const healthContribution = totalLabeledNodes > 0
      ? (stats.count / totalLabeledNodes) * (1 - degreePenalty * 0.5)
      : 0;

    labelBreakdown[label] = {
      nodeCount: stats.count,
      avgDegree: Math.round(avgDegree * 1000) / 1000,
      healthContribution: Math.round(healthContribution * 1000) / 1000,
    };
  }

  // ── Re-score with typed anti-patterns ──────────────────────────────────

  let adjustedScore = baseHealth.overallScore;
  for (const ap of typedAntiPatterns) {
    switch (ap.severity) {
      case 'critical': adjustedScore -= 8; break;
      case 'warning': adjustedScore -= 4; break;
      case 'info': adjustedScore -= 1; break;
    }
  }

  return {
    ...baseHealth,
    overallScore: Math.max(0, Math.min(100, Math.round(adjustedScore))),
    typedAntiPatterns,
    labelBreakdown,
  };
}
