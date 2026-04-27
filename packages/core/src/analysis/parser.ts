/**
 * Astrolabe — Multi-language parser orchestrator.
 *
 * Wraps `web-tree-sitter` and provides a unified API for parsing source
 * files across all supported languages. Handles:
 *
 * - WASM runtime initialisation (call `initParser()` once at startup)
 * - Grammar loading & caching (language instances are singletons)
 * - Query execution (symbols + imports)
 * - Export detection (via `export_statement` parent check)
 * - Parse-result caching via {@link AstCache}
 */

import { Parser as WtsParser, Query as WtsQuery, Language as WtsLanguage } from 'web-tree-sitter';
import type { QueryMatch } from 'web-tree-sitter';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  LanguageDefinition,
  FileParseResult,
  ParsedSymbol,
  ParsedImport,
  ParsedRelationship,
} from './language-definition.js';
import { symbolId } from './language-definition.js';
import { languageForExtension, languageForFile } from './languages/index.js';
import { AstCache } from './ast-cache.js';
import type { NodeLabel } from '@astrolabe/shared';

// ── Module-level state ─────────────────────────────────────────────────────

let _initialized = false;

/**
 * Cache of loaded WASM Language instances.
 * Keyed by LanguageDefinition.wasmFile (path).
 */
const languageCache = new Map<string, WtsLanguage>();

/**
 * Cache of compiled Query instances.
 * Keyed by query pattern string — queries are reusable across files
 * as long as the language object is the same.
 */
const queryCache = new Map<string, WtsQuery>();

/**
 * Cache of WtsParser instances keyed by WASM file path.
 * Reusing parsers avoids allocation overhead per file (#168).
 */
const parserCache = new Map<string, WtsParser>();

/**
 * Get or create a cached parser for the given language.
 */
function getParser(language: WtsLanguage, wasmFile: string): WtsParser {
  let parser = parserCache.get(wasmFile);
  if (!parser) {
    parser = new WtsParser();
    parser.setLanguage(language);
    parserCache.set(wasmFile, parser);
  }
  return parser;
}

/**
 * Parse-result cache keyed by file path.
 */
const astCache = new AstCache();

// ── Initialisation ─────────────────────────────────────────────────────────

/**
 * Initialise the web-tree-sitter WASM runtime.
 *
 * **Must be called once** before any parsing can happen.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initParser(): Promise<void> {
  if (_initialized) return;
  await WtsParser.init();
  _initialized = true;
}

// ── WASM directory resolution ──────────────────────────────────────────────

// Cache to avoid repeated path computation.
let _wasmDir: string | undefined;

/**
 * Return the default WASM directory for tree-sitter grammars.
 *
 * Resolves relative to this source file's location (not process.cwd()),
 * so it works when consumed as a library by the CLI or VSCode extension.
 *
 * Source: packages/core/src/analysis/parser.ts
 * WASM:   packages/core/wasm/
 */
export function defaultWasmDir(): string {
  if (_wasmDir !== undefined) return _wasmDir;

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    _wasmDir = resolve(__dirname, '..', '..', 'wasm');
  } catch {
    // Fallback for environments where import.meta.url is unavailable (CJS/require)
    _wasmDir = resolve(process.cwd(), 'wasm');
  }
  return _wasmDir;
}

/**
 * Reset the parser module state (language cache, query cache, AST cache).
 * Useful for testing and cleanup.
 */
export function resetParser(): void {
  languageCache.clear();
  queryCache.clear();
  parserCache.clear();
  astCache.clear();
  _initialized = false;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Load (or retrieve from cache) the WASM Language instance for a given
 * language definition.
 */
async function loadLanguage(def: LanguageDefinition, wasmDir: string): Promise<WtsLanguage> {
  const key = def.wasmFile;
  let lang = languageCache.get(key);
  if (!lang) {
    lang = await def.load(wasmDir);
    languageCache.set(key, lang);

    // Also load extra WASM files (e.g. TSX for TypeScript) so the
    // secondary grammar is cached alongside the primary one.
    if (def.extraWasmFiles) {
      for (const extraFile of def.extraWasmFiles) {
        if (!languageCache.has(extraFile)) {
          const wasmPath = resolve(wasmDir, extraFile);
          const extraLang: WtsLanguage = await WtsLanguage.load(wasmPath);
          languageCache.set(extraFile, extraLang);
        }
      }
    }
  }
  return lang;
}

/**
 * Get or create a compiled Query instance.
 */
function getQuery(language: WtsLanguage, pattern: string, langKey?: string): WtsQuery {
  const key = langKey ? `${langKey}|${pattern}` : `${pattern}`;
  let q = queryCache.get(key);
  if (!q) {
    q = new WtsQuery(language, pattern);
    queryCache.set(key, q);
  }
  return q;
}

/**
 * Determine if the outer node of a match is exported by checking if its
 * parent node is an `export_statement`.
 */
function isExported(match: QueryMatch, outerCapture: string): boolean {
  for (const c of match.captures) {
    if (c.name === outerCapture) {
      const parent = c.node.parent;
      // Check if the symbol is directly wrapped in an export statement
      if (parent && parent.type === 'export_statement') return true;
      return false;
    }
  }
  return false;
}

/**
 * Label priority for deduplication. More specific labels beat less
 * specific ones. E.g. a Method inside an impl block beats a Function
 * match for the same node (#178).
 */
const LABEL_PRIORITY: Partial<Record<string, number>> = {
  Constructor: 4,
  Property: 3,
  Method: 3,
  Function: 1,
  Class: 1,
  Interface: 1,
  Enum: 1,
  Struct: 1,
  Trait: 1,
};

function shouldReplaceDedup(
  existing: ParsedSymbol | undefined,
  candidate: ParsedSymbol,
): boolean {
  if (!existing) return true;
  // Exported always beats non-exported
  if (!existing.isExported && candidate.isExported) return true;
  if (existing.isExported && !candidate.isExported) return false;
  // Different labels: more specific (higher priority) wins
  if (existing.label !== candidate.label) {
    const existingPrio = LABEL_PRIORITY[existing.label] ?? 1;
    const candidatePrio = LABEL_PRIORITY[candidate.label] ?? 1;
    return candidatePrio >= existingPrio;
  }
  // Same label: keep existing (dedup)
  return false;
}

/**
 * Extract symbol declarations from query matches.
 * Deduplicates by symbol ID — if the same symbol is captured by two
 * patterns (e.g. exported and non-exported versions), only one entry
 * is kept, preferring the exported version.
 */
function extractSymbols(
  matches: QueryMatch[],
  patterns: LanguageDefinition['symbolPatterns'],
  filePath: string,
): { symbols: ParsedSymbol[]; relationships: ParsedRelationship[] } {
  const seen = new Map<string, ParsedSymbol>();
  const relationships: ParsedRelationship[] = [];

  for (let pi = 0; pi < matches.length; pi++) {
    const match = matches[pi];
    const patternIndex = (match as any)._patternIndex ?? match.patternIndex;
    const pattern = patterns[patternIndex] ?? patterns[pi];

    // Find the outer capture — this defines the symbol node
    const outerCapture = pattern.outerCapture;
    const outerNode = match.captures.find((c) => c.name === outerCapture);
    if (!outerNode) continue;

    // Find the name capture
    const nameCapture = pattern.nameCapture;
    const nameNode = match.captures.find((c) => c.name === nameCapture);
    const name = nameNode ? nameNode.node.text : `anon_${outerNode.node.startPosition.row + 1}`;

    const label = pattern.captureLabels[outerCapture] as NodeLabel;
    if (!label) continue;

    const startLine = outerNode.node.startPosition.row + 1;
    const endLine = outerNode.node.endPosition.row + 1;
    const exported = isExported(match, outerCapture);

    const id = symbolId(label, filePath, name, startLine);
    // Dedup by filePath|name|startLine (exclude label) so the same node
    // matched by multiple patterns produces only one entry.
    // Use label priority: more specific labels (Method, Constructor) beat
    // less specific ones (Function) to fix Rust impl method dedup (#178).
    const dedupKey = `${filePath}|${name}|${startLine}`;
    const existing = seen.get(dedupKey);

    if (shouldReplaceDedup(existing, { id, filePath, name, label, startLine, endLine, isExported: exported })) {
      seen.set(dedupKey, {
        id,
        filePath,
        name,
        label,
        startLine,
        endLine,
        isExported: exported,
      });
    }

    // Collect relationship captures (EXTENDS, IMPLEMENTS, etc.) (#170)
    if (pattern.relationshipCaptures) {
      for (const [captureName, relType] of Object.entries(pattern.relationshipCaptures)) {
        const relNode = match.captures.find((c) => c.name === captureName);
        if (relNode) {
          relationships.push({
            filePath,
            sourceName: name,
            sourceStartLine: startLine,
            targetName: relNode.node.text,
            type: relType,
          });
        }
      }
    }
  }

  return { symbols: Array.from(seen.values()), relationships };
}

/**
 * Extract import information from query matches.
 * Groups multiple names from the same import statement together.
 * Handles tree-sitter returning separate matches per import_specifier
 * by merging names from all matches sharing the same source|startLine key.
 */
function extractImports(
  matches: QueryMatch[],
  patterns: LanguageDefinition['importPatterns'],
  filePath: string,
): ParsedImport[] {
  const grouped = new Map<string, ParsedImport>();

  for (let pi = 0; pi < matches.length; pi++) {
    const match = matches[pi];
    const patternIndex = (match as any)._patternIndex ?? match.patternIndex;
    const pattern = patterns[patternIndex] ?? patterns[pi];

    const outerCapture = pattern.outerCapture;
    const outerNode = match.captures.find((c) => c.name === outerCapture);
    if (!outerNode) continue;

    // Get the source module path
    const sourceNode = match.captures.find((c) => c.name === 'source');
    const source = sourceNode ? sourceNode.node.text : 'unknown';

    // Get the imported names from this match
    const nameNodes = match.captures.filter((c) => c.name === pattern.nameCapture);
    const defaultNameNodes = match.captures.filter((c) => c.name === 'default_name');

    const names: { name: string; isDefault: boolean }[] = [];

    for (const n of defaultNameNodes) {
      names.push({ name: n.node.text, isDefault: true });
    }
    for (const n of nameNodes) {
      if (!names.some((existing) => existing.name === n.node.text && existing.isDefault)) {
        names.push({ name: n.node.text, isDefault: false });
      }
    }

    if (names.length === 0 && nameNodes.length === 0 && source !== 'unknown') {
      // Side-effect import: `import './foo'`
      names.push({ name: source, isDefault: false });
    }

    const startLine = outerNode.node.startPosition.row + 1;
    const key = `${source}|${startLine}`;

    const existing = grouped.get(key);
    if (existing) {
      // Merge names from this match into the existing entry,
      // avoiding duplicates
      for (const n of names) {
        if (!existing.names.some((en) => en.name === n.name && en.isDefault === n.isDefault)) {
          existing.names.push(n);
        }
      }
    } else {
      const id = symbolId('Import', filePath, source, startLine);
      grouped.set(key, {
        id,
        filePath,
        source,
        names,
        startLine,
      });
    }
  }

  return Array.from(grouped.values());
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse a single source file using the appropriate tree-sitter grammar.
 *
 * @param filePath  Absolute path to the source file.
 * @param wasmDir   Absolute path to the directory containing WASM grammar files.
 * @returns A {@link FileParseResult} with extracted symbols and imports.
 *
 * @throws If the parser has not been initialised (`initParser()` not called).
 * @throws If the language is not supported (unknown file extension).
 */
export async function parseFile(
  filePath: string,
  wasmDir: string,
): Promise<FileParseResult> {
  if (!_initialized) {
    throw new Error(
      'Parser not initialised. Call initParser() before parseFile().',
    );
  }

  // Normalise path separators
  const normalisedPath = filePath.replace(/\\/g, '/');

  // Check cache first
  try {
    const st = statSync(normalisedPath);
    const cached = astCache.get(normalisedPath, st.mtimeMs);
    if (cached) return cached;
  } catch {
    // If stat fails, proceed without cache
  }

  // Determine language
  const ext = extname(normalisedPath).toLowerCase();
  const langDef = languageForExtension(ext);
  if (!langDef) {
    const result: FileParseResult = {
      filePath: normalisedPath,
      language: 'typescript' as never, // unreachable: parse-emit phase filters via isParsable()
      symbols: [],
      imports: [],
      relationships: [],
      error: `Unsupported file extension: ${ext}`,
    };
    return result;
  }

  // Load language WASM
  const language = await loadLanguage(langDef, wasmDir);

  // Read file content
  let content: string;
  try {
    content = readFileSync(normalisedPath, 'utf-8');
  } catch (err) {
    return {
      filePath: normalisedPath,
      language: langDef.name,
      symbols: [],
      imports: [],
      relationships: [],
      error: `Failed to read file: ${(err as Error).message}`,
    };
  }

  // Parse — reuse cached parser per language (#168)
  const parser = getParser(language, langDef.wasmFile);
  const tree = parser.parse(content);
  if (!tree) {
    return {
      filePath: normalisedPath,
      language: langDef.name,
      symbols: [],
      imports: [],
      relationships: [],
      error: 'Parse returned null tree',
    };
  }

  const root = tree.rootNode;

  // ── Symbol extraction ──────────────────────────────────────────────────
  const allSymbolMatches: QueryMatch[] = [];
  for (let pi = 0; pi < langDef.symbolPatterns.length; pi++) {
    const pattern = langDef.symbolPatterns[pi];
    const query = getQuery(language, pattern.query, langDef.wasmFile);
    const matches = query.matches(root);
    for (const m of matches) {
      // Tag with the actual pattern index since each pattern is its own
      // Query and would otherwise have patternIndex=0 on every match.
      (m as any)._patternIndex = pi;
      allSymbolMatches.push(m);
    }
  }

  const { symbols, relationships } = extractSymbols(allSymbolMatches, langDef.symbolPatterns, normalisedPath);

  // ── Import extraction
  const allImportMatches: QueryMatch[] = [];
  for (let pi = 0; pi < langDef.importPatterns.length; pi++) {
    const pattern = langDef.importPatterns[pi];
    const query = getQuery(language, pattern.query, langDef.wasmFile);
    const matches = query.matches(root);
    for (const m of matches) {
      (m as any)._patternIndex = pi;
      allImportMatches.push(m);
    }
  }

  const imports = extractImports(allImportMatches, langDef.importPatterns, normalisedPath);

  // Clean up tree — parser is cached and reused (#168)
  tree.delete();

  // Build result
  const result: FileParseResult = {
    filePath: normalisedPath,
    language: langDef.name,
    symbols,
    imports,
    relationships,
  };

  // Cache
  try {
    const st = statSync(normalisedPath);
    astCache.set(normalisedPath, st.mtimeMs, result);
  } catch {
    // Don't cache if stat fails
  }

  return result;
}

/**
 * Parse multiple files, optionally bounded by concurrency limit.
 *
 * @param filePaths  Array of absolute file paths.
 * @param wasmDir    Absolute path to WASM directory.
 * @param concurrency  Max parallel parses (default 8). 0 = unbounded.
 * @returns Array of {@link FileParseResult} in the same order as input.
 */
export async function parseFiles(
  filePaths: string[],
  wasmDir: string,
  concurrency = 8,
): Promise<FileParseResult[]> {
  if (filePaths.length === 0) return [];
  if (concurrency <= 0 || concurrency >= filePaths.length) {
    return Promise.all(filePaths.map((fp) => parseFile(fp, wasmDir)));
  }

  const results: FileParseResult[] = new Array(filePaths.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < filePaths.length) {
      const i = cursor++;
      results[i] = await parseFile(filePaths[i], wasmDir);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return results;
}

/**
 * Parse source code provided as a string (not from a file).
 * Uses a dummy file path for language detection and cache key.
 *
 * @param source    Source code as a string.
 * @param filePath  Logical file path for language detection (e.g. "src/foo.ts").
 * @param wasmDir   Directory containing tree-sitter WASM grammars.
 */
export async function parseString(
  source: string,
  filePath: string,
  wasmDir: string,
): Promise<FileParseResult> {
  if (!_initialized) {
    throw new Error('Parser not initialised. Call initParser() before parseString().');
  }

  const normalisedPath = filePath.replace(/\\/g, '/');
  const langDef = languageForFile(filePath);
  if (!langDef) {
    return {
      filePath: normalisedPath,
      language: 'typescript' as never,
      symbols: [],
      imports: [],
      relationships: [],
      error: `Unsupported file extension for ${filePath}`,
    };
  }

  const language = await loadLanguage(langDef, wasmDir);
  const parser = getParser(language, langDef.wasmFile);
  const tree = parser.parse(source);
  if (!tree) {
    return { filePath: normalisedPath, language: langDef.name, symbols: [], imports: [], relationships: [], error: 'Parse returned null tree' };
  }

  const root = tree.rootNode;

  // Symbol extraction
  const allSymbolMatches: QueryMatch[] = [];
  for (let pi = 0; pi < langDef.symbolPatterns.length; pi++) {
    const pattern = langDef.symbolPatterns[pi];
    const query = getQuery(language, pattern.query, langDef.wasmFile);
    for (const m of query.matches(root)) {
      (m as any)._patternIndex = pi;
      allSymbolMatches.push(m);
    }
  }
  const { symbols, relationships } = extractSymbols(allSymbolMatches, langDef.symbolPatterns, normalisedPath);

  // Import extraction
  const allImportMatches: QueryMatch[] = [];
  for (let pi = 0; pi < langDef.importPatterns.length; pi++) {
    const pattern = langDef.importPatterns[pi];
    const query = getQuery(language, pattern.query, langDef.wasmFile);
    for (const m of query.matches(root)) {
      (m as any)._patternIndex = pi;
      allImportMatches.push(m);
    }
  }
  const imports = extractImports(allImportMatches, langDef.importPatterns, normalisedPath);

  // Clean up tree — parser is cached and reused (#168)
  tree.delete();

  return { filePath: normalisedPath, language: langDef.name, symbols, imports, relationships };
}

// ── Re-exports for convenience ─────────────────────────────────────────────

export { languageForExtension, languageForFile, getAllExtensions } from './languages/index.js';
export { AstCache } from './ast-cache.js';
