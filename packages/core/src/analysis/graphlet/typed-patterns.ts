/**
 * Graphlet Analysis — Typed architectural pattern detection (#872).
 *
 * Extends untyped graphlet pattern detection with type-aware motif profiles.
 * Typed motif keys (e.g. "Class:CALLS:Function") enable richer, more specific
 * pattern detection such as controller-fat, callback-hell, and circular imports.
 */

import type { GraphletProfile } from './counter.js';
import type { ArchitecturePattern } from './patterns.js';

// #872: Typed motif key — e.g. "Class:CALLS:Function", "Module:IMPORTS:Module"
export type TypedMotifKey = `${string}:${string}:${string}`;

/** Typed motif summary — maps typed motif keys to their occurrence counts */
export type TypedMotifSummary = Record<TypedMotifKey, number>;

// #872: Typed architectural pattern — extends untyped pattern with typed indicators
export interface TypedArchitecturePattern extends ArchitecturePattern {
  /** Typed motif keys that triggered this detection */
  typedIndicators: TypedMotifKey[];
}

// ── Thresholds ──────────────────────────────────────────────────────────────

/** Minimum total typed entries before relying on typed analysis */
const TYPED_THRESHOLD = 5;
/** Star motif count threshold for "high star" detection */
const STAR_HIGH = 6;
/** Diamond motif count threshold for "high diamond" detection */
const DIAMOND_HIGH = 4;
/** Chain motif count threshold for "high chain" detection */
const CHAIN_HIGH = 8;
/** Cycle motif count threshold for "high cycle" detection */
const CYCLE_HIGH = 3;
/** Interface method count threshold for segregation violation */
const INTERFACE_METHOD_LIMIT = 8;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sum all values in a typed motif summary.
 * Returns 0 for empty or undefined summaries.
 */
function typedTotal(summary: TypedMotifSummary): number {
  let total = 0;
  for (const val of Object.values(summary)) {
    total += val;
  }
  return total;
}

/**
 * Extract motif keys matching a prefix pattern (e.g. "Class:CALLS:").
 * Returns matching keys sorted by count descending.
 */
function keysWithPrefix(summary: TypedMotifSummary, prefix: string): TypedMotifKey[] {
  const entries = Object.entries(summary)
    .filter(([key]) => key.startsWith(prefix))
    .sort(([, a], [, b]) => b - a);
  return entries.map(([key]) => key as TypedMotifKey);
}

/**
 * Sum counts for all keys matching a prefix.
 */
function sumPrefix(summary: TypedMotifSummary, prefix: string): number {
  let sum = 0;
  for (const [key, val] of Object.entries(summary)) {
    if (key.startsWith(prefix)) {
      sum += val;
    }
  }
  return sum;
}

/**
 * Sum counts for all keys matching a regex.
 */
function sumMatching(summary: TypedMotifSummary, pattern: RegExp): number {
  let sum = 0;
  for (const [key, val] of Object.entries(summary)) {
    if (pattern.test(key)) {
      sum += val;
    }
  }
  return sum;
}

// ── Typed pattern detectors ─────────────────────────────────────────────────

/**
 * Detect Controller-Fat pattern: high star motifs where a Class calls many
 * Functions or Methods — a "fat controller" anti-pattern.
 */
function detectControllerFat(summary: TypedMotifSummary): TypedArchitecturePattern | null {
  const classCallsFn = sumPrefix(summary, 'Class:CALLS:');
  const classCallsMethod = sumPrefix(summary, 'Class:CALLS:Method');
  const total = classCallsFn + classCallsMethod;

  if (total < STAR_HIGH) return null;

  const indicators = keysWithPrefix(summary, 'Class:CALLS:');
  const confidence = Math.min(1, total / (STAR_HIGH * 3));

  return {
    name: 'Controller-Fat',
    confidence,
    description: `Classes calling many functions/methods (star motif). ` +
      `${total} outgoing Class→Function/Method edges suggest fat controllers that should be decomposed.`,
    indicators: [
      `Class:CALLS star count: ${total} (threshold: ${STAR_HIGH})`,
      ...indicators.slice(0, 5).map(k => `${k}: ${summary[k]}`),
    ],
    typedIndicators: indicators,
  };
}

/**
 * Detect Data-Clump pattern: high diamond motifs where the same label quartet
 * repeats — e.g. Class:USES:Class edges forming convergent-divergent patterns.
 */
function detectDataClump(summary: TypedMotifSummary): TypedArchitecturePattern | null {
  // Look for repeated same-label diamond patterns (A:USES:B, A:USES:B again)
  const usesEdges = sumPrefix(summary, 'Class:USES:');
  const classDiamond = sumMatching(summary, /^Class:USES:Class/);

  if (classDiamond < DIAMOND_HIGH && usesEdges < DIAMOND_HIGH) return null;

  const indicators = keysWithPrefix(summary, 'Class:USES:');
  const confidence = Math.min(1, (classDiamond + usesEdges) / (DIAMOND_HIGH * 2));

  return {
    name: 'Data-Clump',
    confidence,
    description: `Diamond-shaped data dependency patterns detected. ` +
      `${classDiamond} Class→Class USES edges forming diamond motifs suggest data clumps — ` +
      `groups of data always passed together that should be encapsulated.`,
    indicators: [
      `Class:USES:Class diamond count: ${classDiamond}`,
      `Class:USES total: ${usesEdges}`,
    ],
    typedIndicators: indicators,
  };
}

/**
 * Detect Inheritance-Deep pattern: high chain motifs in Class:EXTENDS:Class
 * patterns indicating deep inheritance hierarchies.
 */
function detectInheritanceDeep(summary: TypedMotifSummary): TypedArchitecturePattern | null {
  const extendsChains = sumPrefix(summary, 'Class:EXTENDS:');

  if (extendsChains < CHAIN_HIGH) return null;

  const indicators = keysWithPrefix(summary, 'Class:EXTENDS:');
  const confidence = Math.min(1, extendsChains / (CHAIN_HIGH * 2));

  return {
    name: 'Inheritance-Deep',
    confidence,
    description: `Deep inheritance chains detected via Class:EXTENDS edges. ` +
      `${extendsChains} extend chains suggest hierarchies deeper than 3 levels, ` +
      `which increase coupling and make changes harder to trace.`,
    indicators: [
      `Class:EXTENDS chain count: ${extendsChains} (threshold: ${CHAIN_HIGH})`,
    ],
    typedIndicators: indicators,
  };
}

/**
 * Detect Callback-Hell pattern: high chain motifs in Function:CALLS:Function
 * patterns indicating deeply nested or chained function calls.
 */
function detectCallbackHell(summary: TypedMotifSummary): TypedArchitecturePattern | null {
  const fnCallsFn = sumPrefix(summary, 'Function:CALLS:Function');
  const fnCallsMethod = sumPrefix(summary, 'Function:CALLS:Method');
  const methodCallsFn = sumPrefix(summary, 'Method:CALLS:Function');
  const methodCallsMethod = sumPrefix(summary, 'Method:CALLS:Method');
  const total = fnCallsFn + fnCallsMethod + methodCallsFn + methodCallsMethod;

  if (total < CHAIN_HIGH) return null;

  const indicators: TypedMotifKey[] = [
    ...keysWithPrefix(summary, 'Function:CALLS:'),
    ...keysWithPrefix(summary, 'Method:CALLS:'),
  ];
  const confidence = Math.min(1, total / (CHAIN_HIGH * 3));

  return {
    name: 'Callback-Hell',
    confidence,
    description: `Long call chains detected among functions and methods. ` +
      `${total} Function/Method→Function/Method chains suggest deeply nested ` +
      `or sequential callback patterns that reduce readability.`,
    indicators: [
      `Function:CALLS:Function: ${fnCallsFn}`,
      `Function:CALLS:Method: ${fnCallsMethod}`,
      `Method:CALLS:Function: ${methodCallsFn}`,
      `Method:CALLS:Method: ${methodCallsMethod}`,
    ],
    typedIndicators: indicators.slice(0, 10),
  };
}

/**
 * Detect Interface-Segregation-Violation: high star motifs with
 * Interface:HAS_METHOD:Method where the interface center has too many methods.
 */
function detectInterfaceSegregation(summary: TypedMotifSummary): TypedArchitecturePattern | null {
  const hasMethodCount = sumPrefix(summary, 'Interface:HAS_METHOD:');

  if (hasMethodCount < INTERFACE_METHOD_LIMIT) return null;

  const indicators = keysWithPrefix(summary, 'Interface:HAS_METHOD:');
  const confidence = Math.min(1, hasMethodCount / (INTERFACE_METHOD_LIMIT * 2));

  return {
    name: 'Interface-Segregation-Violation',
    confidence,
    description: `Interfaces with too many methods detected. ` +
      `${hasMethodCount} Interface:HAS_METHOD edges suggest interfaces with ` +
      `>${INTERFACE_METHOD_LIMIT} methods, violating the Interface Segregation Principle.`,
    indicators: [
      `Interface:HAS_METHOD count: ${hasMethodCount} (threshold: ${INTERFACE_METHOD_LIMIT})`,
    ],
    typedIndicators: indicators,
  };
}

/**
 * Detect Circular-Import pattern: high cycle motifs in Module:IMPORTS:Module
 * patterns indicating circular dependency chains between modules.
 */
function detectCircularImport(summary: TypedMotifSummary): TypedArchitecturePattern | null {
  const importCycles = sumPrefix(summary, 'Module:IMPORTS:');

  if (importCycles < CYCLE_HIGH) return null;

  const indicators = keysWithPrefix(summary, 'Module:IMPORTS:');
  const confidence = Math.min(1, importCycles / (CYCLE_HIGH * 2));

  return {
    name: 'Circular-Import',
    confidence,
    description: `Circular import patterns detected via Module:IMPORTS edges. ` +
      `${importCycles} import edges forming cycle motifs indicate circular dependencies ` +
      `between modules that can cause build and initialization issues.`,
    indicators: [
      `Module:IMPORTS cycle count: ${importCycles} (threshold: ${CYCLE_HIGH})`,
    ],
    typedIndicators: indicators,
  };
}

/**
 * Detect Cross-Cutting-Concern pattern: high star motifs where edges are
 * DECORATES or USES types — indicating concerns spread across many modules.
 */
function detectCrossCuttingConcern(summary: TypedMotifSummary): TypedArchitecturePattern | null {
  const decoratesEdges = sumMatching(summary, /:DECORATES:/);
  const usesEdges = sumMatching(summary, /:USES:/);
  const total = decoratesEdges + usesEdges;

  if (total < STAR_HIGH) return null;

  const decoratesKeys = Object.keys(summary)
    .filter(k => k.includes(':DECORATES:'))
    .sort((a, b) => summary[b as TypedMotifKey] - summary[a as TypedMotifKey])
    .map(k => k as TypedMotifKey);
  const usesKeys = Object.keys(summary)
    .filter(k => k.includes(':USES:'))
    .sort((a, b) => summary[b as TypedMotifKey] - summary[a as TypedMotifKey])
    .map(k => k as TypedMotifKey);

  const indicators = [...decoratesKeys, ...usesKeys];
  const confidence = Math.min(1, total / (STAR_HIGH * 2));

  return {
    name: 'Cross-Cutting-Concern',
    confidence,
    description: `Cross-cutting concerns detected via DECORATES and USES star motifs. ` +
      `${decoratesEdges} DECORATES edges and ${usesEdges} USES edges spread across ` +
      `multiple node types suggest concerns not properly modularized.`,
    indicators: [
      `DECORATES edges: ${decoratesEdges}`,
      `USES edges: ${usesEdges}`,
    ],
    typedIndicators: indicators.slice(0, 10),
  };
}

// ── Main detection ──────────────────────────────────────────────────────────

/**
 * Detect architectural patterns from typed graphlet profiles.
 *
 * Runs type-aware pattern detection for richer results, then falls back to
 * untyped pattern detection when typed data is sparse. Results are sorted by
 * confidence descending.
 *
 * @param typedProfile - Typed motif summary (e.g. {"Class:CALLS:Function": 12})
 * @param untypedProfile - Standard graphlet profile for fallback detection
 * @returns Typed architectural patterns sorted by confidence
 */
// #872: Main typed pattern detection entry point
export function detectTypedPatterns(
  typedProfile: TypedMotifSummary,
  untypedProfile: GraphletProfile,
): TypedArchitecturePattern[] {
  const patterns: TypedArchitecturePattern[] = [];
  const hasTypedData = typedTotal(typedProfile) >= TYPED_THRESHOLD;

  // Run typed detectors when we have enough data
  if (hasTypedData) {
    const typedDetectors = [
      detectControllerFat,
      detectDataClump,
      detectInheritanceDeep,
      detectCallbackHell,
      detectInterfaceSegregation,
      detectCircularImport,
      detectCrossCuttingConcern,
    ];

    for (const detector of typedDetectors) {
      const result = detector(typedProfile);
      if (result !== null) {
        patterns.push(result);
      }
    }
  }

  // Fallback: run untyped pattern detection when typed data is sparse
  // or to supplement typed results
  const untypedTotal = untypedProfile.motif3.empty + untypedProfile.motif3.oneEdge
    + untypedProfile.motif3.twoEdge + untypedProfile.motif3.triangle
    + untypedProfile.motif4.chain + untypedProfile.motif4.star
    + untypedProfile.motif4.diamond + untypedProfile.motif4.cycle
    + untypedProfile.motif4.clique;

  if (!hasTypedData || untypedTotal > 0) {
    // Import detectPatterns lazily via dynamic pattern matching
    // to avoid circular dependency issues
    const untypedPatterns = computeUntypedFallback(untypedProfile);
    for (const p of untypedPatterns) {
      // Don't duplicate patterns already detected via typed analysis
      const alreadyDetected = patterns.some(tp => tp.name === p.name);
      if (!alreadyDetected) {
        patterns.push({
          ...p,
          typedIndicators: [],
        });
      }
    }
  }

  // Sort by confidence descending
  patterns.sort((a, b) => b.confidence - a.confidence);

  // If no pattern matched, return generic
  if (patterns.length === 0) {
    patterns.push({
      name: 'No dominant pattern',
      confidence: 0.5,
      description: 'Typed graphlet distribution does not strongly match any known pattern. ' +
        'The codebase may use a mixed or unconventional structure.',
      indicators: ['no dominant typed motif class'],
      typedIndicators: [],
    });
  }

  return patterns;
}

// ── Untyped fallback (inline to avoid circular import) ──────────────────────

/**
 * Compute untyped architectural patterns from a graphlet profile.
 *
 * This is an inline version of the untyped pattern detection logic to avoid
 * circular imports while providing fallback detection when typed data is sparse.
 */
// #872: Inline untyped fallback (mirrors patterns.ts logic)
function computeUntypedFallback(profile: GraphletProfile): ArchitecturePattern[] {
  const patterns: ArchitecturePattern[] = [];
  const total3 = profile.motif3.empty + profile.motif3.oneEdge
    + profile.motif3.twoEdge + profile.motif3.triangle;
  const total4 = profile.motif4.chain + profile.motif4.star
    + profile.motif4.diamond + profile.motif4.cycle + profile.motif4.clique;

  if (total3 === 0 && total4 === 0) {
    return [{
      name: 'Insufficient data',
      confidence: 1,
      description: 'Not enough graphlet motifs detected to determine architectural pattern.',
      indicators: ['zero motifs found'],
    }];
  }

  const triangleRatio = total3 > 0 ? profile.motif3.triangle / total3 : 0;
  const chainRatio = total4 > 0 ? profile.motif4.chain / total4 : 0;
  const starRatio = total4 > 0 ? profile.motif4.star / total4 : 0;
  const diamondRatio = total4 > 0 ? profile.motif4.diamond / total4 : 0;
  const cycleRatio = total4 > 0 ? profile.motif4.cycle / total4 : 0;
  const cliqueRatio = total4 > 0 ? profile.motif4.clique / total4 : 0;
  const twoEdgeRatio = total3 > 0 ? profile.motif3.twoEdge / total3 : 0;

  if (chainRatio > 0.35 && starRatio < 0.3) {
    patterns.push({
      name: 'Layered',
      confidence: Math.min(1, chainRatio * 1.5),
      description: 'Layered architecture with sequential dependency chains.',
      indicators: [
        `chain ratio: ${(chainRatio * 100).toFixed(1)}% (high)`,
        `star ratio: ${(starRatio * 100).toFixed(1)}% (low)`,
      ],
    });
  }

  if (starRatio > 0.3) {
    patterns.push({
      name: 'Microservices',
      confidence: Math.min(1, starRatio * 1.5),
      description: 'Hub-and-spoke dependency topology typical of microservice architectures.',
      indicators: [`star ratio: ${(starRatio * 100).toFixed(1)}% (high)`],
    });
  }

  if (starRatio > 0.2 && diamondRatio > 0.2) {
    patterns.push({
      name: 'Event-driven',
      confidence: Math.min(1, (starRatio + diamondRatio) * 0.8),
      description: 'Event-driven architecture with fan-out and fan-in patterns.',
      indicators: [
        `star ratio: ${(starRatio * 100).toFixed(1)}%`,
        `diamond ratio: ${(diamondRatio * 100).toFixed(1)}%`,
      ],
    });
  }

  if (diamondRatio > 0.3 && starRatio < 0.25) {
    patterns.push({
      name: 'MVC / Layered with diamonds',
      confidence: Math.min(1, diamondRatio * 1.3),
      description: 'Diamond-shaped dependencies suggesting MVC or layered architecture.',
      indicators: [`diamond ratio: ${(diamondRatio * 100).toFixed(1)}% (high)`],
    });
  }

  if (triangleRatio > 0.3 || cliqueRatio > 0.2) {
    patterns.push({
      name: 'Monolithic',
      confidence: Math.min(1, Math.max(triangleRatio, cliqueRatio) * 1.5),
      description: 'Tightly coupled codebase with many inter-module dependencies.',
      indicators: [
        `triangle ratio: ${(triangleRatio * 100).toFixed(1)}%`,
        `clique ratio: ${(cliqueRatio * 100).toFixed(1)}%`,
      ],
    });
  }

  if (total4 > 0 && starRatio > 0.1 && starRatio < 0.35
    && chainRatio > 0.1 && chainRatio < 0.4
    && cliqueRatio < 0.15 && cycleRatio < 0.2) {
    const balance = 1 - Math.abs(starRatio - chainRatio);
    patterns.push({
      name: 'Modular',
      confidence: Math.min(1, balance * 1.2),
      description: 'Well-structured modular architecture with balanced dependency patterns.',
      indicators: [
        `star ratio: ${(starRatio * 100).toFixed(1)}%`,
        `chain ratio: ${(chainRatio * 100).toFixed(1)}%`,
        'balanced distribution',
      ],
    });
  }

  if (cycleRatio > 0.2) {
    patterns.push({
      name: 'Circular dependencies',
      confidence: Math.min(1, cycleRatio * 2),
      description: 'Significant number of 4-node cycles detected.',
      indicators: [`cycle ratio: ${(cycleRatio * 100).toFixed(1)}% (high)`],
    });
  }

  if (twoEdgeRatio > 0.6 && total3 > 10) {
    patterns.push({
      name: 'High coupling',
      confidence: Math.min(1, twoEdgeRatio),
      description: 'Predominance of 2-edge path motifs suggesting long dependency chains.',
      indicators: [`2-edge path ratio: ${(twoEdgeRatio * 100).toFixed(1)}% (high)`],
    });
  }

  return patterns;
}
