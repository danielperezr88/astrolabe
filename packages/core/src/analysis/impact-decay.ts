// #806: Shared constants and functions for probabilistic impact analysis
// Used by both MCP server (server.ts) and CLI (cli/src/index.ts)
// Extracted to shared module per reviewer feedback on PR #817

/** Confidence decay factors per edge type for probabilistic impact propagation */
export const EDGE_DECAY_FACTORS: Record<string, number> = {
  CALLS: 0.9,
  IMPORTS: 0.7,
  EXTENDS: 0.8,
  IMPLEMENTS: 0.85,
  USES: 0.6,
  ACCESSES: 0.65,
  CONTAINS: 0.95,
  DEFINES: 0.95,
  QUERIES: 0.75,
  ROUTES: 0.7,
  MEMBER_OF: 0.3,
  ENTRY_POINT_OF: 0.4,
  HAS_PROPERTY: 0.5,
  CHAINABLE_TO: 0.7,
  CO_CHANGES: 0.8,
  SEMANTICALLY_SIMILAR: 0.6,
  IMPLEMENTS_PATTERN: 0.7,
};

export type DecaySchedule = 'linear' | 'exponential' | 'logarithmic';

/** Apply distance-based decay to a confidence score */
export function applyDecay(
  baseConfidence: number,
  depth: number,
  schedule: DecaySchedule,
): number {
  if (schedule === 'exponential') {
    return baseConfidence * Math.exp(-0.3 * (depth - 1));
  }
  if (schedule === 'logarithmic') {
    return baseConfidence / Math.log2(depth + 1);
  }
  // linear (default): no distance penalty
  return baseConfidence;
}

/** Noisy-OR fusion — combine multiple independent path probabilities */
export function noisyOr(probs: number[]): number {
  return 1 - probs.reduce((acc, p) => acc * (1 - p), 1);
}
