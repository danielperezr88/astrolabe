/**
 * Graphlet Analysis — Barrel export (#461, #872).
 *
 * Re-exports graphlet counting, pattern detection, and health scoring.
 * Also re-exports typed (semantic) variants from #872.
 */

// #461: Graphlet motif counting
export { countGraphlets, buildAdjacencyMap, type GraphletProfile } from './counter.js';

// #461: Architectural pattern detection
export { detectPatterns, type ArchitecturePattern } from './patterns.js';

// #461: Architecture health scoring
export { scoreArchitectureHealth, type ArchitectureHealth, type CommunityInfo } from './health.js';

// #872: Typed (semantic) graphlet counting
export {
  buildTypedAdjacencyMap,
  countTypedGraphlets,
  emptyTypedProfile,
  type TypedAdjacencyMap,
  type TypedMotifKey as TypedCounterMotifKey,
  type TypedGraphletProfile,
} from './typed-counter.js';

// #872: Typed architectural pattern detection
export {
  detectTypedPatterns,
  type TypedMotifKey,
  type TypedMotifSummary,
  type TypedArchitecturePattern,
} from './typed-patterns.js';

// #872: Typed architecture health scoring
export {
  scoreTypedArchitectureHealth,
  type TypedAntiPattern,
  type TypedArchitectureHealth,
  type LabelHealthBreakdown,
} from './typed-health.js';
