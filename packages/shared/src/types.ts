/**
 * Astrolabe — Shared type definitions.
 *
 * Single source of truth for the knowledge graph data model.
 * All node labels, relationship types, and interfaces are defined here.
 * Consumed by all packages via `@astrolabe-dev/shared`.
 */

// ── Supported languages ────────────────────────────────────────────────────

export const SUPPORTED_LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'python',
  'java',
  'csharp',
  'go',
  'rust',
  'php',
  'ruby',
  'swift',
  'c',
  'cpp',
  'dart',
  'kotlin',
  'vue',
  'protobuf',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// ── Node labels ────────────────────────────────────────────────────────────

/**
 * Every node in the knowledge graph has exactly one label.
 * The label determines what properties the node carries and how it's rendered.
 */
/**
 * Node label taxonomy.
 *
 * Some labels overlap in scope (e.g., Method ⊆ Function, Struct ⊆ Class-like).
 * The LABEL_PRIORITY map in parser.ts handles deduplication: when tree-sitter
 * matches the same node with multiple patterns, the more-specific label wins
 * (Method > Function, Constructor > Method, Property > Variable, etc.).
 *
 * Resolution order for overlapping labels:
 *   Constructor > Property > Method > Function, Class, Interface, Struct
 */
export type NodeLabel =
  // Structural
  | 'Project'
  | 'Package'
  | 'Module'
  | 'Folder'
  | 'File'
  // Language constructs
  | 'Class'
  | 'Function'
  | 'Method'
  | 'Variable'
  | 'Interface'
  | 'Enum'
  | 'Decorator'
  | 'Import'
  | 'Type'
  | 'CodeElement'
  // Synthetic
  | 'Community'
  | 'Process'
  // Design patterns
  | 'PatternInstance'
  // Multi-language extras
  | 'Struct'
  | 'Macro'
  | 'Typedef'
  | 'Union'
  | 'Namespace'
  | 'Trait'
  | 'Impl'
  | 'TypeAlias'
  | 'Const'
  | 'Static'
  | 'Property'
  | 'Record'
  | 'Delegate'
  | 'Annotation'
  | 'Constructor'
  | 'Template'
  | 'Section'
  | 'Route'
  | 'Tool'
  | 'Framework';

// ── Node properties ────────────────────────────────────────────────────────

/**
 * Property bag attached to every graph node.
 * All fields are optional — different node labels carry different properties.
 * The `[key: string]: unknown` indexer allows extensibility for custom phases.
 */
export interface NodeProperties {
  /** Display name (function name, class name, file name, etc.) */
  name?: string;
  /** Absolute or repo-relative file path */
  filePath?: string;
  /** Source location */
  startLine?: number;
  endLine?: number;
  /** Programming language */
  language?: SupportedLanguage | string;
  /** Whether the symbol is exported from its module */
  isExported?: boolean;
  // Community detection
  heuristicLabel?: string;
  cohesion?: number;
  symbolCount?: number;
  keywords?: string[];
  description?: string;
  enrichedBy?: 'heuristic' | 'llm';
  // Process tracing
  processType?: 'intra_community' | 'cross_community';
  stepCount?: number;
  communities?: string[];
  entryPointId?: string;
  terminalId?: string;
  entryPointScore?: number;
  entryPointReason?: string;
  // Method / property metadata
  parameterCount?: number;
  level?: number;
  returnType?: string;
  declaredType?: string;
  visibility?: string;
  isStatic?: boolean;
  isReadonly?: boolean;
  isAbstract?: boolean;
  isFinal?: boolean;
  isVirtual?: boolean;
  isOverride?: boolean;
  isAsync?: boolean;
  isPartial?: boolean;
  annotations?: string[];
  // Route / tool metadata
  responseKeys?: string[];
  errorKeys?: string[];
  middleware?: string[];
  /** Extensible catch-all */
  [key: string]: unknown;
}

// ── Relationship types ─────────────────────────────────────────────────────

/**
 * Every edge in the knowledge graph has exactly one type.
 * Types describe the semantic relationship between two nodes.
 */
export type RelationshipType =
  | 'CONTAINS'
  | 'CALLS'
  | 'EXTENDS'
  | 'METHOD_OVERRIDES'
  | 'METHOD_IMPLEMENTS'
  | 'IMPORTS'
  | 'USES'
  | 'DEFINES'
  | 'DECORATES'
  | 'IMPLEMENTS'
  | 'HAS_METHOD'
  | 'HAS_PROPERTY'
  | 'ACCESSES'
  | 'MEMBER_OF'
  | 'STEP_IN_PROCESS'
  | 'HANDLES_ROUTE'
  | 'FETCHES'
  | 'HANDLES_TOOL'
  | 'ENTRY_POINT_OF'
  | 'WRAPS'
  | 'QUERIES'
  | 'USES_FRAMEWORK'
  | 'RETURNS_TYPE'
  | 'DECLARES_TYPE'
  | 'CHAINABLE_TO'
  | 'SEMANTICALLY_SIMILAR'
  | 'IMPLEMENTS_PATTERN';

// ── Evidence for edge provenance ───────────────────────────────────────────

/**
 * Per-signal evidence trace for why an edge was created with a given
 * confidence score.
 *
 * TODO(#253): This type is wired into GraphRelationship but never populated
 * by any analysis phase. Currently only round-tripped through SQLite as
 * empty arrays. Implement evidence tracking in the resolution pipeline.
 */
export interface EvidenceSignal {
  readonly kind: string;
  readonly weight: number;
  readonly note?: string;
}

// ── Graph primitives ───────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  label: NodeLabel;
  properties: NodeProperties;
}

export interface GraphRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  /** Confidence score 0–1. 1.0 = certain (e.g., declared extends), lower = inferred. */
  confidence: number;
  /** Human-readable reason this edge was created. */
  reason: string;
  /** Optional ordinal for ordered relationships (e.g., STEP_IN_PROCESS). */
  step?: number;
  /** Provenance evidence from the resolution pipeline. */
  evidence?: readonly EvidenceSignal[];
}

// ── Knowledge graph interface ──────────────────────────────────────────────

/**
 * The core data structure — a mutable, in-memory property graph.
 *
 * Nodes and relationships are stored in Maps keyed by their IDs,
 * providing O(1) lookup for all operations.
 */
export interface KnowledgeGraph {
  // ── Accessors ──────────────────────────────────────────────────────────
  readonly nodes: GraphNode[];
  readonly relationships: GraphRelationship[];
  readonly nodeCount: number;
  readonly relationshipCount: number;

  // ── Iteration ──────────────────────────────────────────────────────────
  iterNodes(): IterableIterator<GraphNode>;
  iterRelationships(): IterableIterator<GraphRelationship>;
  iterRelationshipsByType(type: RelationshipType): IterableIterator<GraphRelationship>;
  forEachNode(fn: (node: GraphNode) => void): void;
  forEachRelationship(fn: (rel: GraphRelationship) => void): void;

  // ── Lookup ─────────────────────────────────────────────────────────────
  getNode(id: string): GraphNode | undefined;
  getRelationship(id: string): GraphRelationship | undefined;

  // ── Query ───────────────────────────────────────────────────────────────
  findNodesByLabel(label: string): GraphNode[];
  findNodesByProperty(key: string, value: unknown): GraphNode[];

  // ── Mutation ───────────────────────────────────────────────────────────
  addNode(node: GraphNode): void;
  addRelationship(relationship: GraphRelationship): void;
  removeNode(nodeId: string): boolean;
  removeNodesByFile(filePath: string): number;
  removeRelationship(relationshipId: string): boolean;
}
