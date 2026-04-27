/**
 * Astrolabe — Language definition types.
 *
 * Each supported language (JavaScript, TypeScript, Python, etc.) implements
 * the {@link LanguageDefinition} interface so the analysis pipeline can parse
 * files, extract symbols, and discover imports without knowing the specifics
 * of each grammar.
 */

import type { Language as WtsLanguage, QueryMatch } from 'web-tree-sitter';
import type { SupportedLanguage, NodeLabel, RelationshipType } from '@astrolabe/shared';

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
 * Format: `<label>:<filePath>:<name>`
 * For anonymous / unnamed symbols, appends startLine to guarantee uniqueness.
 */
export function symbolId(label: NodeLabel, filePath: string, name: string, startLine?: number): string {
  const base = `${label}:${filePath}:${name}`;
  return startLine != null ? `${base}:L${startLine}` : base;
}
