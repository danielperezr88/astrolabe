/**
 * @astrolabe/core — Public API.
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
} from '@astrolabe/shared';

export { createKnowledgeGraph } from './core/graph.js';
export { runPipeline, createPhaseContext, getPhaseOutput, type PhaseDefinition, type PhaseContext } from './core/pipeline.js';
export { initParser, parseFile, parseFiles, parseString, resetParser, AstCache, defaultWasmDir, languageForExtension, languageForFile, getAllExtensions } from './analysis/parser.js';
export { symbolId, captureText, captureRange } from './analysis/language-definition.js';
export type { LanguageDefinition, QueryPattern, ParsedSymbol, ParsedImport, FileParseResult } from './analysis/language-definition.js';
export { scanPhase, structurePhase, parseEmitPhase, resolutionPhase } from './analysis/phases/index.js';
export type { FileEntry, ScanOutput } from './analysis/phases/scan.js';
export type { StructureOutput } from './analysis/phases/structure.js';
export type { ParseEmitOutput } from './analysis/phases/parse-emit.js';
export type { ResolutionOutput } from './analysis/phases/resolution.js';
export { createSqliteStore } from './persist/index.js';
export type { SqliteStore } from './persist/sqlite.js';
export { createFtsSearch } from './search/index.js';
export type { FtsSearch, SearchResult } from './search/fts.js';
