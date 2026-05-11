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

// ── Parse-result cache (separate from AST tree cache) ───────────────────────

/**
 * Simple content-addressable cache keyed by file path + last-modified time.
 * Stores parsed results so that re-parsing unchanged files is a no-op.
 * This is distinct from the AST tree cache (AstCache) which caches raw trees.
 */
class ParseResultCache {
  private readonly _store = new Map<string, { mtimeMs: number; result: FileParseResult }>();

  get(filePath: string, mtimeMs: number): FileParseResult | undefined {
    const entry = this._store.get(filePath);
    if (!entry) return undefined;
    if (entry.mtimeMs !== mtimeMs) {
      this._store.delete(filePath);
      return undefined;
    }
    return entry.result;
  }

  set(filePath: string, mtimeMs: number, result: FileParseResult): void {
    this._store.set(filePath, { mtimeMs, result });
  }

  clear(): void {
    this._store.clear();
  }
}
import type { NodeLabel } from '@astrolabe-dev/shared';
import { preprocessVueSfc } from './languages/vue.js';

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
 * Stores FileParseResult objects (not tree objects) with mtimeMs-based invalidation.
 */
const parseResultCache = new ParseResultCache();

/**
 * AST tree cache — stores raw Tree-sitter Tree objects for reuse by
 * downstream pipeline phases. Managed by the pipeline (created before
 * phases, cleared after).
 */
const treeCache = new AstCache();

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
  parseResultCache.clear();
  treeCache.clear();
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
  languageName: string,
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

    // #405: Compute parameter count for overload disambiguation
    let paramCount: number | undefined;
    if (label === 'Method' || label === 'Function' || label === 'Constructor') {
      // Walk the AST to find the `parameters` child (standard tree-sitter convention)
      for (let i = 0; i < outerNode.node.childCount; i++) {
        const child = outerNode.node.child(i);
        if (child && (child.type === 'parameters' || child.type === 'formal_parameters')) {
          paramCount = child.namedChildCount;
          break;
        }
      }
    }

    // #635: Extract parameter types early for overload disambiguation
    const paramTypes = (label === 'Method' || label === 'Function' || label === 'Constructor')
      ? extractParameterTypes(outerNode.node, languageName)
      : [];

    // #635: Detect C++ const-qualified methods
    let isConst = false;
    if ((languageName === 'cpp' || languageName === 'c') && (label === 'Method' || label === 'Function')) {
      for (let i = 0; i < outerNode.node.childCount; i++) {
        const child = outerNode.node.child(i);
        if (child && child.type === 'const') {
          isConst = true;
          break;
        }
      }
    }

    const id = symbolId(label, filePath, name, startLine, { parameterCount: paramCount, parameterTypes: paramTypes, isConst });
    // Dedup by filePath|name|startLine|paramCount|paramTypes so overloaded methods
    // with the same name but different parameter types are not collapsed.
    // Use label priority: more specific labels (Method, Constructor) beat
    // less specific ones (Function) to fix Rust impl method dedup (#178).
    const dedupKey = `${filePath}|${name}|${startLine}|${paramCount ?? 0}|${paramTypes.join(',')}`;
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

    // Collect type annotation text from captures (#376)
    if (pattern.typeAnnotationCaptures) {
      const entry = seen.get(dedupKey);
      if (entry) {
        const annotations = entry.typeAnnotations || (entry.typeAnnotations = {});
        for (const [captureName, propName] of Object.entries(pattern.typeAnnotationCaptures)) {
          const typeNode = match.captures.find((c) => c.name === captureName);
          if (typeNode && !annotations[propName]) {
            annotations[propName] = typeNode.node.text;
          }
        }
      }
    }

    // #432: Extract metadata from AST for function-like symbols and Property nodes
    if (label === 'Function' || label === 'Method' || label === 'Constructor' || label === 'Property') {
      const metadata = extractSymbolMetadata(outerNode.node, label, languageName);
      if (Object.keys(metadata).length > 0) {
        const entry = seen.get(dedupKey);
        if (entry) {
          if (!entry.properties) entry.properties = {};
          for (const [key, value] of Object.entries(metadata)) {
            if (entry.properties[key] === undefined) {
              entry.properties[key] = value;
            }
          }
        }
      }
    }

    // #635: Store paramCount in node properties for downstream consumers
    if (paramCount != null) {
      const entry = seen.get(dedupKey);
      if (entry) {
        if (!entry.properties) entry.properties = {};
        if (entry.properties.paramCount === undefined) {
          entry.properties.paramCount = paramCount;
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

// ── Symbol metadata extraction (#432) ────────────────────────────────────────

/** Tree-sitter node types that represent function-like constructs. */
const FUNCTION_LIKE_TYPES = new Set([
  'function_declaration', 'method_definition', 'function_expression',
  'arrow_function', 'function_definition', 'method_declaration',
  'constructor_declaration', 'abstract_method_signature',
]);

/** Parameter container node types across all supported languages. */
const PARAM_CONTAINER_TYPES = new Set(['formal_parameters', 'parameters', 'parameter_list']);

/**
 * Find the actual function-like node within an outer capture node.
 * For direct captures (function_declaration, method_definition), returns itself.
 * For wrapped captures (lexical_declaration containing arrow_function), finds the inner node.
 */
function findFunctionNode(outerNode: any): any {
  if (FUNCTION_LIKE_TYPES.has(outerNode.type)) return outerNode;
  for (let i = 0; i < outerNode.childCount; i++) {
    const child = outerNode.child(i);
    if (!child) continue;
    if (FUNCTION_LIKE_TYPES.has(child.type)) return child;
    if (child.type === 'variable_declarator') {
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (inner && FUNCTION_LIKE_TYPES.has(inner.type)) return inner;
      }
    }
  }
  return outerNode;
}

/** Find the parameter container node within a function node. */
function findParamsNode(funcNode: any): any {
  if (funcNode.childForFieldName) {
    const byField = funcNode.childForFieldName('parameters');
    if (byField) return byField;
  }
  for (let i = 0; i < funcNode.childCount; i++) {
    const child = funcNode.child(i);
    if (child && PARAM_CONTAINER_TYPES.has(child.type)) return child;
  }
  return null;
}

/** Find a direct child node by its type name. */
function findChildByType(node: any, type: string): any {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === type) return child;
  }
  return null;
}

/**
 * #635: Extract ONLY the parameter type strings from a tree-sitter AST node
 * for overload disambiguation. Returns an empty array when no typed params are found.
 * This is a lightweight version of extractSymbolMetadata() that runs BEFORE symbolId()
 * so that parameterTypes can be threaded into the ID construction.
 */
function extractParameterTypes(node: any, languageName: string): string[] {
  const funcNode = findFunctionNode(node);
  const params = findParamsNode(funcNode);
  if (!params) return [];

  switch (languageName) {
    case 'typescript':
    case 'tsx':
    case 'javascript': {
      const types = extractParamTypesTs(params);
      return types ?? [];
    }
    case 'python': {
      const types = extractParamTypesPython(params);
      return types ?? [];
    }
    case 'java': {
      const types = extractParamTypesJava(params);
      return types ?? [];
    }
    case 'csharp': {
      const types = extractParamTypesCSharp(params);
      return types ?? [];
    }
    // C/C++: parameter types come from type descriptors in parameter_list
    case 'cpp':
    case 'c': {
      const types = extractParamTypesCpp(params);
      return types ?? [];
    }
    default:
      return [];
  }
}

/**
 * #635: Extract parameter type strings from C/C++ parameter lists.
 * C/C++ parameters use `parameter_declaration` nodes with an optional `type` child.
 * Also handles `optional_parameter_declaration` (C++ default arguments).
 */
function extractParamTypesCpp(paramsNode: any): string[] | undefined {
  const types: string[] = [];
  let hasAny = false;
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) { types.push(''); continue; }
    // parameter_declaration or optional_parameter_declaration
    const typeDecl = param.childForFieldName
      ? param.childForFieldName('type')
      : null;
    if (typeDecl) {
      types.push(typeDecl.text);
      hasAny = true;
    } else {
      // Fallback: first named child is often the type in C/C++
      const firstNamed = param.namedChildCount > 0 ? param.namedChild(0) : null;
      if (firstNamed && firstNamed.type !== 'identifier') {
        types.push(firstNamed.text);
        hasAny = true;
      } else {
        types.push('');
      }
    }
  }
  return hasAny ? types : undefined;
}

/**
 * #432: Extract metadata (parameterTypes, returnType, visibility, isStatic, isAsync, isAbstract)
 * from a tree-sitter AST node for Function/Method/Constructor symbols.
 * Only includes properties that are explicitly present in the source code.
 */
function extractSymbolMetadata(
  node: any,
  label: string,
  languageName: string,
): Record<string, unknown> {
  if (label !== 'Function' && label !== 'Method' && label !== 'Constructor' && label !== 'Property') return {};

  const props: Record<string, unknown> = {};
  const funcNode = findFunctionNode(node);

  switch (languageName) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
      extractTsJsMetadata(node, funcNode, props);
      break;
    case 'python':
      extractPythonMetadata(funcNode, props);
      break;
    case 'java':
      extractJavaMetadata(funcNode, props);
      break;
    case 'csharp':
      extractCSharpMetadata(funcNode, props);
      break;
  }

  return props;
}

// ── TypeScript / JavaScript metadata ─────────────────────────────────────

function extractTsJsMetadata(
  outerNode: any,
  funcNode: any,
  props: Record<string, unknown>,
): void {
  // Modifiers: check both outer capture node and inner function node
  for (const target of [outerNode, funcNode]) {
    for (let i = 0; i < target.childCount; i++) {
      const child = target.child(i);
      if (!child) continue;
      if (child.type === 'accessibility_modifier') {
        const t = child.text;
        if (t === 'public' || t === 'private' || t === 'protected') props.visibility = t;
      }
      if (child.type === 'static' || child.text === 'static') props.isStatic = true;
      if (child.type === 'async' || child.text === 'async') props.isAsync = true;
      if (child.type === 'abstract' || child.text === 'abstract') props.isAbstract = true;
    }
  }

  // Parameter types
  const params = findParamsNode(funcNode);
  if (params) {
    const types = extractParamTypesTs(params);
    if (types) props.parameterTypes = types;
  }

  // Return type
  const rt = extractReturnTypeTs(funcNode);
  if (rt) props.returnType = rt;
}

function extractParamTypesTs(paramsNode: any): string[] | undefined {
  const types: string[] = [];
  let hasAny = false;
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) { types.push(''); continue; }
    // required_parameter / optional_parameter have 'type' field pointing to type_annotation
    const ta = param.childForFieldName
      ? param.childForFieldName('type') ?? findChildByType(param, 'type_annotation')
      : findChildByType(param, 'type_annotation');
    if (ta) {
      const inner = ta.childForFieldName ? ta.childForFieldName('type') : null;
      const text = inner ? inner.text : ta.text.replace(/^:\s*/, '');
      types.push(text);
      if (text) hasAny = true;
    } else {
      types.push('');
    }
  }
  return hasAny ? types : undefined;
}

function extractReturnTypeTs(funcNode: any): string | undefined {
  const rt = funcNode.childForFieldName
    ? funcNode.childForFieldName('return_type')
    : null;
  if (rt) {
    const inner = rt.childForFieldName ? rt.childForFieldName('type') : null;
    return inner ? inner.text : rt.text.replace(/^:\s*/, '');
  }
  const ta = findChildByType(funcNode, 'type_annotation');
  if (ta) return ta.text.replace(/^:\s*/, '');
  return undefined;
}

// ── Python metadata ──────────────────────────────────────────────────────

function extractPythonMetadata(funcNode: any, props: Record<string, unknown>): void {
  // async check — "async" is a keyword child of function_definition
  for (let i = 0; i < funcNode.childCount; i++) {
    const child = funcNode.child(i);
    if (child && child.text === 'async') { props.isAsync = true; break; }
  }

  // Parameter types
  const params = findParamsNode(funcNode);
  if (params) {
    const types = extractParamTypesPython(params);
    if (types) props.parameterTypes = types;
  }

  // Return type (field: 'return_type')
  const rt = funcNode.childForFieldName ? funcNode.childForFieldName('return_type') : null;
  if (rt) props.returnType = rt.text;

  // Visibility convention: _prefix = protected, __prefix (not __dunder__) = private
  const nameNode = funcNode.childForFieldName ? funcNode.childForFieldName('name') : null;
  if (nameNode) {
    const name = nameNode.text;
    if (name.startsWith('__') && !name.endsWith('__')) props.visibility = 'private';
    else if (name.startsWith('_') && !name.startsWith('__')) props.visibility = 'protected';
  }
}

function extractParamTypesPython(paramsNode: any): string[] | undefined {
  const types: string[] = [];
  let hasAny = false;
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) { types.push(''); continue; }
    if (param.type === 'typed_parameter' || param.type === 'typed_default_parameter') {
      const t = param.childForFieldName ? param.childForFieldName('type') : null;
      if (t) {
        types.push(t.text);
        hasAny = true;
        continue;
      }
    }
    types.push('');
  }
  return hasAny ? types : undefined;
}

// ── Java metadata ────────────────────────────────────────────────────────

function extractJavaMetadata(funcNode: any, props: Record<string, unknown>): void {
  // Modifiers are in a 'modifiers' child node
  const modifiers = findChildByType(funcNode, 'modifiers');
  if (modifiers) {
    for (let i = 0; i < modifiers.childCount; i++) {
      const m = modifiers.child(i);
      if (!m) continue;
      const t = m.text;
      if (t === 'public' || t === 'private' || t === 'protected') props.visibility = t;
      if (t === 'static') props.isStatic = true;
      if (t === 'abstract') props.isAbstract = true;
    }
  }

  // Return type (for methods, not constructors)
  if (funcNode.type === 'method_declaration') {
    const rt = funcNode.childForFieldName ? funcNode.childForFieldName('type') : null;
    if (rt) props.returnType = rt.text;
  }

  // Parameter types
  const params = findParamsNode(funcNode);
  if (params) {
    const types = extractParamTypesJava(params);
    if (types) props.parameterTypes = types;
  }
}

function extractParamTypesJava(paramsNode: any): string[] | undefined {
  const types: string[] = [];
  let hasAny = false;
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) { types.push(''); continue; }
    const t = param.childForFieldName ? param.childForFieldName('type') : null;
    if (t) {
      types.push(t.text);
      hasAny = true;
    } else {
      types.push('');
    }
  }
  return hasAny ? types : undefined;
}

// ── C# metadata ──────────────────────────────────────────────────────────

function extractCSharpMetadata(funcNode: any, props: Record<string, unknown>): void {
  // Modifiers are individual 'modifier' children (not wrapped in a container)
  for (let i = 0; i < funcNode.childCount; i++) {
    const child = funcNode.child(i);
    if (!child || child.type !== 'modifier') continue;
    const t = child.text;
    if (t === 'public' || t === 'private' || t === 'protected' || t === 'internal') props.visibility = t;
    if (t === 'static') props.isStatic = true;
    if (t === 'async') props.isAsync = true;
    if (t === 'abstract') props.isAbstract = true;
  }

  // Return type
  if (funcNode.type === 'method_declaration') {
    const rt = funcNode.childForFieldName ? funcNode.childForFieldName('type') : null;
    if (rt) props.returnType = rt.text;
  }

  // Parameter types
  const params = findParamsNode(funcNode);
  if (params) {
    const types = extractParamTypesCSharp(params);
    if (types) props.parameterTypes = types;
  }
}

function extractParamTypesCSharp(paramsNode: any): string[] | undefined {
  const types: string[] = [];
  let hasAny = false;
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) { types.push(''); continue; }
    const t = param.childForFieldName ? param.childForFieldName('type') : null;
    if (t) {
      types.push(t.text);
      hasAny = true;
    } else {
      types.push('');
    }
  }
  return hasAny ? types : undefined;
}

// ── Shared extraction helper (#169) ────────────────────────────────────────

/**
 * #281: Extract decorator/annotation usage from the AST.
 *
 * Runs decoratorPatterns queries against the tree, extracts decorator names,
 * and produces ParsedRelationship entries with type 'DECORATES'.
 *
 * The nameCapture from each pattern identifies the decorator name.
 * No node creation is done here — only relationship edges.
 */
function extractDecorators(
  language: WtsLanguage,
  root: any,
  langDef: LanguageDefinition,
  normalisedPath: string,
): ParsedRelationship[] {
  const relationships: ParsedRelationship[] = [];

  for (const pattern of langDef.decoratorPatterns!) {
    const query = getQuery(language, pattern.query, langDef.wasmFile);
    const matches = query.matches(root);

    for (const match of matches) {
      const nameNode = match.captures.find((c: any) => c.name === pattern.nameCapture);
      if (!nameNode) continue;

      const decoratorName = nameNode.node.text;
      const startLine = nameNode.node.startPosition.row + 1;

      // #341: Walk up to find the decorated declaration's name
      const decoratedNode = nameNode.node.parent;
      let sourceName = '';
      let sourceStartLine = startLine;

      if (decoratedNode) {
        // The parent of a decorator is a declaration (class, method, etc.)
        // Walk children to find the 'name' node
        for (let i = 0; i < decoratedNode.childCount; i++) {
          const child = decoratedNode.child(i);
          if (child && (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'property_identifier')) {
            const fieldName = decoratedNode.fieldNameForChild && decoratedNode.fieldNameForChild(i);
            if (fieldName === 'name' || !fieldName) {
              sourceName = child.text;
              sourceStartLine = child.startPosition.row + 1;
              break;
            }
          }
        }
        // Fallback: if name not found via field, use the first identifier-like child
        if (!sourceName) {
          for (let i = 0; i < decoratedNode.childCount; i++) {
            const child = decoratedNode.child(i);
            if (child && child.type === 'identifier') {
              sourceName = child.text;
              sourceStartLine = child.startPosition.row + 1;
              break;
            }
          }
        }
      }

      relationships.push({
        filePath: normalisedPath,
        sourceName,
        sourceStartLine,
        targetName: decoratorName,
        type: 'DECORATES',
      });
    }
  }

  return relationships;
}

/**
 * Run symbol and import queries against a tree and extract results.
 * Shared by both parseFile and parseString to avoid ~40 lines of duplicated
 * query-matching logic per function.
 */
function extractFromTree(
  language: WtsLanguage,
  root: any,
  langDef: LanguageDefinition,
  normalisedPath: string,
): { symbols: ParsedSymbol[]; imports: ParsedImport[]; relationships: ParsedRelationship[] } {
  // Symbol extraction
  const allSymbolMatches: QueryMatch[] = [];
  for (let pi = 0; pi < langDef.symbolPatterns.length; pi++) {
    const pattern = langDef.symbolPatterns[pi];
    const query = getQuery(language, pattern.query, langDef.wasmFile);
    const matches = query.matches(root);
    for (const m of matches) {
      (m as any)._patternIndex = pi;
      allSymbolMatches.push(m);
    }
  }
  const { symbols, relationships } = extractSymbols(allSymbolMatches, langDef.symbolPatterns, normalisedPath, langDef.name);

  // Import extraction
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

  // #281: Decorator/annotation extraction
  if (langDef.decoratorPatterns && langDef.decoratorPatterns.length > 0) {
    const decoratorRelationships = extractDecorators(language, root, langDef, normalisedPath);
    relationships.push(...decoratorRelationships);
  }

  return { symbols, imports, relationships };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Check the parse-result cache for an existing entry that matches the
 * file's current mtime. Extracted from {@link parseFile} to break the
 * TOCTOU data-flow trace between `statSync` and `readFileSync`.
 */
function getCachedParseResult(normalisedPath: string): FileParseResult | null {
  let mtimeMs: number | undefined;
  try {
    mtimeMs = statSync(normalisedPath).mtimeMs;
  } catch {
    // File doesn't exist or can't stat — no cache hit
    return null;
  }
  if (mtimeMs !== undefined) {
    const cached = parseResultCache.get(normalisedPath, mtimeMs);
    if (cached) return cached;
  }
  return null;
}

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

  // Check cache first (delegated to break TOCTOU trace)
  const cached = getCachedParseResult(normalisedPath);
  if (cached) return cached;

  // Determine language
  const ext = extname(normalisedPath).toLowerCase();
  const langDef = languageForExtension(ext);
  if (!langDef) {
    const result: FileParseResult = {
      filePath: normalisedPath,
      language: 'unknown',
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

  // #395: Vue SFC preprocessing — extract <script> block content
  if (ext === '.vue') {
    const sfc = preprocessVueSfc(normalisedPath, content);
    if (!sfc) {
      return {
        filePath: normalisedPath,
        language: 'vue',
        symbols: [],
        imports: [],
        relationships: [],
        error: 'No <script> block found in Vue SFC',
      };
    }
    content = sfc.content;
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

  // ── Extract symbols, imports, and relationships (#169) ──────────────────
  const { symbols, imports, relationships } = extractFromTree(language, root, langDef, normalisedPath);

  // Cache the tree for reuse by downstream pipeline phases.
  // The pipeline clears the tree cache after all phases complete,
  // disposing WASM memory. Do NOT call tree.delete() here — the
  // AstCache manages the tree lifecycle via LRU eviction.
  treeCache.set(normalisedPath, tree);

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
    parseResultCache.set(normalisedPath, st.mtimeMs, result);
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
      language: 'unknown',
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

  // ── Extract symbols, imports, and relationships (#169) ──────────────────
  const { symbols, imports, relationships } = extractFromTree(language, root, langDef, normalisedPath);

  // Clean up tree — parser is cached and reused (#168)
  tree.delete();

  return { filePath: normalisedPath, language: langDef.name, symbols, imports, relationships };
}

// ── Re-exports for convenience ─────────────────────────────────────────────

export { languageForExtension, languageForFile, getAllExtensions } from './languages/index.js';
export { AstCache, astCache } from './ast-cache.js';
export { treeCache };
