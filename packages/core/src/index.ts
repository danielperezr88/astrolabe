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
export { scanPhase, structurePhase, frameworkPhase, markdownPhase, parseEmitPhase, resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase, mroPhase, communityPhase, processTracingPhase, cobolPhase, callResolutionPhase, scopeResolutionPhase } from './analysis/phases/index.js';
export type { FileEntry, ScanOutput } from './analysis/phases/scan.js';
export type { StructureOutput } from './analysis/phases/structure.js';
export type { ParseEmitOutput } from './analysis/phases/parse-emit.js';
export type { ResolutionOutput } from './analysis/phases/resolution.js';
export type { CrossFileOutput } from './analysis/phases/cross-file.js';
export type { MroOutput } from './analysis/phases/mro.js';
export type { CommunityOutput } from './analysis/phases/community.js';
export type { ProcessTracingOutput } from './analysis/phases/process-tracing.js';
export { createSqliteStore } from './persist/index.js';
export type { SqliteStore } from './persist/sqlite.js';
export { createFtsSearch, buildTfIdfIndex, searchTfIdf, cosineSimilarity } from './search/index.js';
export type { FtsSearch, SearchResult } from './search/fts.js';
export type { TfIdfVector, SimilarityResult } from './search/embeddings.js';
export { createLogger } from './logging/index.js';
export type { Logger, LogLevel, LogEntry } from './logging/logger.js';
export { startMcpServer, loadRegistry, saveRegistry, removeRepo, getGitRemote, findEntryWithSiblingWarning } from './mcp/index.js';
export { createGroup, removeGroup, addRepoToGroup, removeRepoFromGroup, listGroups, getGroupStatus, groupQuery, loadGroups, saveGroups, autoDetectGroups } from './mcp/index.js';
export type { RegistryEntry } from './mcp/registry.js';
export type { RepoGroup, GroupRepo, GroupsConfig, GroupStatus, ServiceBoundary } from './mcp/index.js';
export { ServiceBoundaryDetector, autoDetectGroups as detectServiceBoundaries } from './analysis/service-boundary-detector.js';
export type { ServiceBoundaryDetectorOptions } from './analysis/service-boundary-detector.js';
export { generateSkill } from './skill/index.js';
export { detectChanges } from './incremental/index.js';
export type { IncrementalState } from './incremental/index.js';
export { autoSetup } from './setup/index.js';
export type { SetupResult } from './setup/index.js';
export { generateWiki } from './wiki/index.js';
export type { WikiOptions, WikiResult } from './wiki/index.js';
export { startHttpServer } from './server/http-server.js';
export type { ServeOptions } from './server/http-server.js';
export { startEvalServer, shutdownEvalServer } from './server/eval-server.js';
export type { EvalServerOptions } from './server/eval-server.js';
export { loadMeta, saveMeta, computeFileDiff, buildMeta } from './analysis/meta.js';
export type { MetaFile, FileDiff } from './analysis/meta.js';
export { installHooks, generateHooksConfig } from './hooks/index.js';
export { generateAgentFiles } from './agents/index.js';
export type { AgentFilesResult } from './agents/index.js';
export { parseFilesParallel, DEFAULT_WORKERS } from './analysis/workers/pool.js';
export type { WorkerParseResult, PoolStats } from './analysis/workers/pool.js';
