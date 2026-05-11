/**
 * Graphlet Analysis — Barrel export (#461).
 *
 * Re-exports graphlet counting, pattern detection, and health scoring.
 */

// #461: Graphlet motif counting
export { countGraphlets, buildAdjacencyMap, type GraphletProfile } from './counter.js';

// #461: Architectural pattern detection
export { detectPatterns, type ArchitecturePattern } from './patterns.js';

// #461: Architecture health scoring
export { scoreArchitectureHealth, type ArchitectureHealth, type CommunityInfo } from './health.js';
