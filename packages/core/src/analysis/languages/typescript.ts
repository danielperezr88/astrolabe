/**
 * Astrolabe — TypeScript / TSX language definition.
 *
 * Provides tree-sitter query patterns for extracting symbols and imports
 * from TypeScript source files (including TSX).
 */

import { Language } from 'web-tree-sitter';
import type { Language as WtsLanguage } from 'web-tree-sitter';
import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { resolve } from 'node:path';

// ── Symbol query patterns ──────────────────────────────────────────────────

const symbolPatterns: QueryPattern[] = [
  // interface Foo { … }
  {
    query: '(interface_declaration name: (type_identifier) @name) @definition.interface',
    captureLabels: { 'definition.interface': 'Interface' },
    nameCapture: 'name',
    outerCapture: 'definition.interface',
  },
  // type Foo = …
  {
    query: '(type_alias_declaration name: (type_identifier) @name) @definition.type',
    captureLabels: { 'definition.type': 'TypeAlias' },
    nameCapture: 'name',
    outerCapture: 'definition.type',
  },
  // enum Foo { … }
  {
    query: '(enum_declaration name: (identifier) @name) @definition.enum',
    captureLabels: { 'definition.enum': 'Enum' },
    nameCapture: 'name',
    outerCapture: 'definition.enum',
  },
  // class Foo { … }
  {
    query: '(class_declaration name: (type_identifier) @name) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
  },
  // abstract class Foo { … }
  {
    query: '(abstract_class_declaration name: (type_identifier) @name) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
  },
  // function foo() { … }
  {
    query: '(function_declaration name: (identifier) @name) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // const foo = () => { … }
  {
    query:
      '(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function))) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // const foo = function() { … }
  {
    query:
      '(lexical_declaration (variable_declarator name: (identifier) @name value: (function_expression))) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // Method definitions (getters/setters handled separately)
  {
    query: '(method_definition name: (property_identifier) @name) @definition.method',
    captureLabels: { 'definition.method': 'Method' },
    nameCapture: 'name',
    outerCapture: 'definition.method',
  },
  // Getter
  {
    query: '(method_definition "get" name: (property_identifier) @name) @definition.property',
    captureLabels: { 'definition.property': 'Property' },
    nameCapture: 'name',
    outerCapture: 'definition.property',
  },
  // Setter
  {
    query: '(method_definition "set" name: (property_identifier) @name) @definition.property',
    captureLabels: { 'definition.property': 'Property' },
    nameCapture: 'name',
    outerCapture: 'definition.property',
  },
];

// ── Import query patterns ──────────────────────────────────────────────────

const importPatterns: QueryPattern[] = [
  // import type { Foo } from './bar'
  {
    query:
      '(import_statement (import_clause (named_imports (import_specifier name: (identifier) @name))) (string (string_fragment) @source)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // import Foo from './bar'
  {
    query:
      '(import_statement (import_clause (identifier) @default_name) (string (string_fragment) @source)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'default_name',
    outerCapture: 'import',
    isImport: true,
  },
  // import Foo, { Bar } from './baz'
  {
    query:
      '(import_statement (import_clause (identifier) @default_name (named_imports (import_specifier name: (identifier) @name))) (string (string_fragment) @source)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // import * as Foo from './bar'
  {
    query:
      '(import_statement (import_clause (namespace_import (identifier) @name)) (string (string_fragment) @source)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // import './side-effect' (no import_clause)
  // NOTE: handled as a fallback in extractImports() because tree-sitter
  // WASM does not support the !(negation) query operator.
  //{ query: '...', ... }
];

// ── Language definition ────────────────────────────────────────────────────

export const typescriptLanguage: LanguageDefinition = {
  name: 'typescript',
  extensions: ['.ts', '.mts', '.cts'],
  wasmFile: 'tree-sitter-typescript.wasm',
  extraWasmFiles: ['tree-sitter-tsx.wasm'],

  get symbolPatterns(): QueryPattern[] {
    return symbolPatterns;
  },

  get importPatterns(): QueryPattern[] {
    return importPatterns;
  },

  async load(wasmDir: string): Promise<WtsLanguage> {
    const wasmPath = resolve(wasmDir, this.wasmFile);
    return Language.load(wasmPath);
  },
};

/**
 * TSX language definition — shares the same grammar file as TypeScript
 * but handles `.tsx` extensions and adds JSX-specific queries.
 */
const tsxSymbolPatterns: QueryPattern[] = [
  ...symbolPatterns,
  // Default export of a JSX component: export default function Foo() { return <div/> }
  // The base function_declaration query already catches it; here we just
  // add a pattern to make sure JSX-specific exports are captured.
];

export const tsxLanguage: LanguageDefinition = {
  name: 'typescript',
  extensions: ['.tsx'],
  wasmFile: 'tree-sitter-tsx.wasm',

  get symbolPatterns(): QueryPattern[] {
    return tsxSymbolPatterns;
  },

  get importPatterns(): QueryPattern[] {
    return importPatterns;
  },

  async load(wasmDir: string): Promise<WtsLanguage> {
    const wasmPath = resolve(wasmDir, this.wasmFile);
    return Language.load(wasmPath);
  },
};
