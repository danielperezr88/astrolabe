/**
 * Astrolabe — Language definition types.
 *
 * Each supported language (JavaScript, TypeScript, Python, etc.) implements
 * the {@link LanguageDefinition} interface so the analysis pipeline can parse
 * files, extract symbols, and discover imports without knowing the specifics
 * of each grammar.
 */

import type { Language as WtsLanguage, QueryMatch } from 'web-tree-sitter';
import type { SupportedLanguage, NodeLabel, RelationshipType } from '@astrolabe-dev/shared';

// ── Import semantics (#279) ─────────────────────────────────────────────────

export type ImportSemantics = 'named' | 'wildcard-leaf' | 'wildcard-transitive' | 'namespace';

/** #278: MRO (Method Resolution Order) strategy per language. */
export type MroStrategy = 'c3' | 'first-wins' | 'none';

// ── Call-resolution hooks (#284) ───────────────────────────────────────────

/** Classification of a call site extracted from source. */
export interface CallSite {
  name: string;
  form: 'free' | 'member' | 'constructor';
  receiver?: string;
  argCount: number;
  filePath: string;
  startLine: number;
}

/** Strategy selected by a language for resolving a call. */
export interface DispatchDecision {
  primary: 'owner-scoped' | 'free' | 'constructor';
  fallback?: 'free-arity-narrowed';
  ancestryView?: 'instance' | 'singleton';
}

/** Language-specific hooks for the 6-stage call-resolution DAG (#284). */
export interface CallResolutionHooks {
  /** Stage 3: Rewrite bare calls to self.method (e.g., Python, Ruby). */
  inferImplicitReceiver?: (call: CallSite) => CallSite;
  /** Stage 4: Choose resolution strategy based on language semantics. */
  selectDispatch?: (call: CallSite) => DispatchDecision;
}

// ── Query pattern ──────────────────────────────────────────────────────────

/**
 * A single tree-sitter query pattern that extracts symbols or relationships
 * from an AST.
 *
 * Each pattern defines:
 * - The S-expression query string
 * - Which capture maps to which graph label
 * - Which capture contains the symbol name
 * - How the resulting data maps to graph entities
 */
export interface QueryPattern {
  /** S-expression query string (e.g. `(function_declaration name: (identifier) @name) @definition.function`). */
  query: string;

  /**
   * Maps capture names to graph node labels.
   * The primary outer capture (e.g. `definition.function`) defines the node label.
   * Additional relationship captures (e.g. `base`) create edges.
   */
  captureLabels: Record<string, NodeLabel>;

  /**
   * The capture name that holds the symbol's display name.
   * E.g. `"name"` for the `@name` capture.
   */
  nameCapture: string;

  /**
   * The capture name that holds the outer definition node.
   * This is the main capture that creates a graph node.
   */
  outerCapture: string;

  /**
   * Optional: relationship types for captures that should create edges
   * between the outer node and the captured node.
   * E.g. `{ base: 'EXTENDS' }` means if `@base` is captured, create an
   * EXTENDS edge from the outer node to the base node.
   */
  relationshipCaptures?: Record<string, RelationshipType>;

  /**
   * Whether this pattern defines an import statement.
   * Import patterns use different capture semantics (source, name, isDefault).
   */
  isImport?: boolean;

  /**
   * Optional: maps capture names to property names for type annotations (#376).
   * When a capture like `@returnType` matches, the parser extracts the
   * type annotation text and stores it as a node property.
   *
   * E.g. `{ returnType: 'returnType', fieldType: 'fieldType' }`
   * This enables cross-file type resolution and return-type-aware binding.
   */
  typeAnnotationCaptures?: Record<string, string>;
}

// ── Language definition contract ───────────────────────────────────────────

/**
 * Interface implemented by each supported language.
 *
 * Provides:
 * - Extension mapping (`.js` → JavaScript, etc.)
 * - WASM grammar file management
 * - Query patterns for symbol / import extraction
 * - Loading of the compiled WASM grammar
 */
export interface LanguageDefinition {
  /** Normalised language identifier. */
  readonly name: SupportedLanguage;
  /** File extensions handled by this language (e.g. `['.js', '.mjs', '.cjs']`). */
  readonly extensions: string[];
  /** Path to the WASM grammar file (relative to the `wasm/` directory). */
  readonly wasmFile: string;
  /** Extra WASM files needed (e.g. TS grammar needs TSX grammar too). */
  readonly extraWasmFiles?: string[];
  /** Query patterns for extracting symbol declarations. */
  readonly symbolPatterns: QueryPattern[];
  /** Query patterns for extracting import statements. */
  readonly importPatterns: QueryPattern[];
  /** #281: Query patterns for extracting decorator/annotation usage. */
  readonly decoratorPatterns?: QueryPattern[];
  /** #860: Call-site extraction patterns for CALLS edge emission. */
  readonly callPatterns?: QueryPattern[];
  /** #279: Import resolution strategy for cross-file symbol lookup. */
  readonly importSemantics: ImportSemantics;
  /** #278: MRO strategy for method resolution inheritance chains. */
  readonly mroStrategy: MroStrategy;
  /** #284: Call-resolution hooks for language-specific behavior. */
  readonly callResolution?: CallResolutionHooks;

  /**
   * Load the WASM grammar(s) and return a Language instance.
   * May be called once; the caller should cache the result.
   */
  load(wasmDir: string): Promise<WtsLanguage>;
}

// ── Parsed output types ────────────────────────────────────────────────────

/** A single symbol extracted from a source file. */
export interface ParsedSymbol {
  /** Globally-unique id (e.g. `fn:src/foo.ts:bar`). */
  id: string;
  /** File where the symbol is defined. */
  filePath: string;
  /** Display name. */
  name: string;
  /** Graph node label. */
  label: NodeLabel;
  /** 1-based start line. */
  startLine: number;
  /** 1-based end line. */
  endLine: number;
  /** Whether the symbol is exported from its module. */
  isExported: boolean;
  /** Type annotations extracted from the AST (#376). E.g. { returnType: 'User' }. */
  typeAnnotations?: Record<string, string>;
  /** #432: Additional symbol metadata (parameterTypes, returnType, visibility, isStatic, isAsync, isAbstract). */
  properties?: Record<string, unknown>;
}

/** A single import relationship extracted from a source file. */
export interface ParsedImport {
  /** Id for the import node itself. */
  id: string;
  /** File containing the import. */
  filePath: string;
  /** Module specifier (e.g. `'./foo'`, `'lodash'`). */
  source: string;
  /** Imported names. */
  names: { name: string; isDefault: boolean }[];
  /** 1-based start line. */
  startLine: number;
}

/** A call site extracted from source code (#860). */
export interface ParsedCallSite {
  /** Name of the called function/method (e.g. 'analyze', 'startWatch'). */
  name: string;
  /** Call form: free (foo()), member (obj.method()), constructor (new Foo()). */
  form: 'free' | 'member' | 'constructor';
  /** Receiver name for member calls (e.g. 'obj' in obj.method()). */
  receiver?: string;
  /** Number of arguments. */
  argCount: number;
  /** File containing the call. */
  filePath: string;
  /** 1-based line number of the call. */
  startLine: number;
}

/** A relationship extracted from a tree-sitter match (e.g. EXTENDS, IMPLEMENTS). */
export interface ParsedRelationship {
  /** Source file path. */
  filePath: string;
  /** Source symbol name. */
  sourceName: string;
  /** Source symbol start line (for deduplication). */
  sourceStartLine: number;
  /** Target symbol name (within same file). */
  targetName: string;
  /** Relationship type (e.g. 'EXTENDS', 'IMPLEMENTS'). */
  type: string;
}

/** Full parse result for a single file. */
export interface FileParseResult {
  filePath: string;
  /** Normalised language identifier, or 'unknown' for unsupported extensions. */
  language: SupportedLanguage | 'unknown';
  /** Symbols declared in this file. */
  symbols: ParsedSymbol[];
  /** Import statements in this file. */
  imports: ParsedImport[];
  /** Relationships extracted from tree-sitter captures (EXTENDS, IMPLEMENTS, etc.). */
  relationships: ParsedRelationship[];
  /** #860: Call sites extracted from source for CALLS edge emission. */
  callSites?: ParsedCallSite[];
  /** Top-level error message if parsing failed entirely. */
  error?: string;
}

// ── Utility helpers ────────────────────────────────────────────────────────

/**
 * Extract the text content of a named capture from a QueryMatch.
 * Returns `undefined` if the capture is not found.
 */
export function captureText(match: QueryMatch, name: string): string | undefined {
  for (const c of match.captures) {
    if (c.name === name) return c.node.text;
  }
  return undefined;
}

/**
 * Extract line range from a named capture in a QueryMatch.
 */
export function captureRange(
  match: QueryMatch,
  name: string,
): { startLine: number; endLine: number } | undefined {
  for (const c of match.captures) {
    if (c.name === name) {
      return {
        startLine: c.node.startPosition.row + 1,
        endLine: c.node.endPosition.row + 1,
      };
    }
  }
  return undefined;
}

/**
 * Build a stable, unique id for a symbol node within a file.
 *
 * Format: `<label>:<filePath>:<name>[#<paramCount>][~<typeHash>]`
 * For anonymous / unnamed symbols, appends startLine to guarantee uniqueness.
 *
 * #405: Overload disambiguation via parameter-count and type-hash suffixes.
 * - `Method:file:MyClass.save#1` — single-parameter version
 * - `Method:file:MyClass.save#2` — two-parameter version
 * - `Method:file:MyClass.save#1~int,string` — type-hash disambiguation for same-arity
 */
export function symbolId(
  label: NodeLabel,
  filePath: string,
  name: string,
  startLine?: number,
  overload?: { parameterCount?: number; parameterTypes?: string[]; isConst?: boolean },
): string {
  let base = `${label}:${filePath}:${name}`;
  if (overload?.parameterCount != null && overload.parameterCount > 0) {
    base += `#${overload.parameterCount}`;
    if (overload.parameterTypes && overload.parameterTypes.length > 0) {
      const hash = overload.parameterTypes.map((t) => t.replace(/[^a-zA-Z0-9<>,_[\]]/g, '')).join(',');
      base += `~${hash}`;
    }
  }
  if (overload?.isConst) {
    base += '\\';
  }
  return startLine != null ? `${base}:L${startLine}` : base;
}
