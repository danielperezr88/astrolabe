/**
 * Astrolabe — Public API.
 *
 * Re-exports everything consumers of the library need.
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
} from './core/types.js';

export { createKnowledgeGraph } from './core/graph.js';
export { runPipeline, type PhaseDefinition, type PhaseContext } from './core/pipeline.js';
