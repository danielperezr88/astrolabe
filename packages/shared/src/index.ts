/**
 * @astrolabe/shared — Public API.
 *
 * Re-exports all shared type definitions consumed by all Astrolabe packages.
 */

export {
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
  type NodeLabel,
  type NodeProperties,
  type RelationshipType,
  type EvidenceSignal,
  type GraphNode,
  type GraphRelationship,
  type KnowledgeGraph,
} from './types.js';

export {
  toPosix,
  pathBasename,
  stripTrailingSep,
  isRelativeImport,
  appDataDir,
} from './path-utils.js';

export {
  AstrolabeError,
  ParseError,
  GraphError,
  QueryError,
  NotFoundError,
  AnalysisError,
  ConfigError,
  isAstrolabeError,
} from './errors.js';
