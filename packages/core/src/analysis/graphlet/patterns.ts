/**
 * Graphlet Analysis — Architectural pattern detection (#461).
 *
 * Maps graphlet frequency distributions to known architectural patterns
 * like layered, microservices, event-driven, MVC, monolithic, and modular.
 */

import type { GraphletProfile } from './counter.js';

// #461: Architectural pattern detected from graphlet analysis
export interface ArchitecturePattern {
  name: string;
  /** Confidence score 0–1 */
  confidence: number;
  /** Human-readable description */
  description: string;
  /** Graphlet indicators that led to this detection */
  indicators: string[];
}

/**
 * Detect architectural patterns from a graphlet profile.
 *
 * Maps motif distributions to well-known architectural styles.
 * Returns patterns sorted by confidence (highest first).
 */
// #461: Main pattern detection entry point
export function detectPatterns(profile: GraphletProfile): ArchitecturePattern[] {
  const patterns: ArchitecturePattern[] = [];
  const total3 = profile.motif3.empty + profile.motif3.oneEdge
    + profile.motif3.twoEdge + profile.motif3.triangle;
  const total4 = profile.motif4.chain + profile.motif4.star
    + profile.motif4.diamond + profile.motif4.cycle + profile.motif4.clique;

  // Guard: not enough data
  if (total3 === 0 && total4 === 0) {
    return [{
      name: 'Insufficient data',
      confidence: 1,
      description: 'Not enough graphlet motifs detected to determine architectural pattern.',
      indicators: ['zero motifs found'],
    }];
  }

  // Compute ratios for classification
  const triangleRatio = total3 > 0 ? profile.motif3.triangle / total3 : 0;
  const chainRatio = total4 > 0 ? profile.motif4.chain / total4 : 0;
  const starRatio = total4 > 0 ? profile.motif4.star / total4 : 0;
  const diamondRatio = total4 > 0 ? profile.motif4.diamond / total4 : 0;
  const cycleRatio = total4 > 0 ? profile.motif4.cycle / total4 : 0;
  const cliqueRatio = total4 > 0 ? profile.motif4.clique / total4 : 0;
  const twoEdgeRatio = total3 > 0 ? profile.motif3.twoEdge / total3 : 0;

  // #461: Layered architecture — high chain count (linear A→B→C→D)
  if (chainRatio > 0.35 && starRatio < 0.3) {
    patterns.push({
      name: 'Layered',
      confidence: Math.min(1, chainRatio * 1.5),
      description: 'Layered architecture with sequential dependency chains. Modules are organized in horizontal tiers with clear top-to-bottom dependencies.',
      indicators: [
        `chain ratio: ${(chainRatio * 100).toFixed(1)}% (high)`,
        `star ratio: ${(starRatio * 100).toFixed(1)}% (low)`,
      ],
    });
  }

  // #461: Microservices — high star count (hub-and-spoke between services)
  if (starRatio > 0.3) {
    patterns.push({
      name: 'Microservices',
      confidence: Math.min(1, starRatio * 1.5),
      description: 'Hub-and-spoke dependency topology typical of microservice architectures. Service gateways or API layers connect many leaf modules.',
      indicators: [
        `star ratio: ${(starRatio * 100).toFixed(1)}% (high)`,
      ],
    });
  }

  // #461: Event-driven — high star + high diamond (fan-out + fan-in)
  if (starRatio > 0.2 && diamondRatio > 0.2) {
    patterns.push({
      name: 'Event-driven',
      confidence: Math.min(1, (starRatio + diamondRatio) * 0.8),
      description: 'Event-driven architecture with fan-out (publish) and fan-in (subscribe) patterns. High star count for event dispatch, high diamond for convergent handlers.',
      indicators: [
        `star ratio: ${(starRatio * 100).toFixed(1)}%`,
        `diamond ratio: ${(diamondRatio * 100).toFixed(1)}%`,
      ],
    });
  }

  // #461: MVC / layered with diamonds — high diamond count
  if (diamondRatio > 0.3 && starRatio < 0.25) {
    patterns.push({
      name: 'MVC / Layered with diamonds',
      confidence: Math.min(1, diamondRatio * 1.3),
      description: 'Diamond-shaped dependency patterns suggest Model-View-Controller or layered architecture where controllers branch to multiple services that converge at data layers.',
      indicators: [
        `diamond ratio: ${(diamondRatio * 100).toFixed(1)}% (high)`,
      ],
    });
  }

  // #461: Monolithic — high triangle + clique (everything connected to everything)
  if (triangleRatio > 0.3 || cliqueRatio > 0.2) {
    const confidence = Math.min(1, Math.max(triangleRatio, cliqueRatio) * 1.5);
    patterns.push({
      name: 'Monolithic',
      confidence,
      description: 'Tightly coupled codebase with many inter-module dependencies. High triangle and clique counts indicate bidirectional and transitive coupling throughout the graph.',
      indicators: [
        `triangle ratio: ${(triangleRatio * 100).toFixed(1)}%`,
        `clique ratio: ${(cliqueRatio * 100).toFixed(1)}%`,
      ],
    });
  }

  // #461: Modular — balanced distribution with moderate star and chain
  if (total4 > 0 && starRatio > 0.1 && starRatio < 0.35
    && chainRatio > 0.1 && chainRatio < 0.4
    && cliqueRatio < 0.15 && cycleRatio < 0.2) {
    const balance = 1 - Math.abs(starRatio - chainRatio);
    patterns.push({
      name: 'Modular',
      confidence: Math.min(1, balance * 1.2),
      description: 'Well-structured modular architecture with balanced dependency patterns. Mix of hub-based interfaces and linear chains with no dominant coupling pattern.',
      indicators: [
        `star ratio: ${(starRatio * 100).toFixed(1)}%`,
        `chain ratio: ${(chainRatio * 100).toFixed(1)}%`,
        `balanced distribution`,
      ],
    });
  }

  // #461: Circular dependency pattern — high cycle count
  if (cycleRatio > 0.2) {
    patterns.push({
      name: 'Circular dependencies',
      confidence: Math.min(1, cycleRatio * 2),
      description: 'Significant number of 4-node cycles detected, indicating circular dependency chains. This is an anti-pattern that can cause maintenance and build issues.',
      indicators: [
        `cycle ratio: ${(cycleRatio * 100).toFixed(1)}% (high)`,
      ],
    });
  }

  // #461: High coupling indicator — two-edge ratio very high
  if (twoEdgeRatio > 0.6 && total3 > 10) {
    patterns.push({
      name: 'High coupling',
      confidence: Math.min(1, twoEdgeRatio),
      description: 'Predominance of 2-edge (path) motifs suggests many intermediary modules. Each change potentially ripples through a long chain of dependencies.',
      indicators: [
        `2-edge path ratio: ${(twoEdgeRatio * 100).toFixed(1)}% (high)`,
      ],
    });
  }

  // Sort by confidence descending
  patterns.sort((a, b) => b.confidence - a.confidence);

  // If no pattern matched, return generic
  if (patterns.length === 0) {
    patterns.push({
      name: 'No dominant pattern',
      confidence: 0.5,
      description: 'Graphlet distribution does not strongly match any known architectural pattern. The codebase may use a mixed or unconventional structure.',
      indicators: ['no dominant motif class'],
    });
  }

  return patterns;
}
