/**
 * Astrolabe — JavaScript language definition.
 *
 * Provides tree-sitter query patterns for extracting symbols and imports
 * from JavaScript / JSX source files.
 */

import { Language } from 'web-tree-sitter';
import type { Language as WtsLanguage } from 'web-tree-sitter';
import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { resolve } from 'node:path';

// ── Symbol query patterns ──────────────────────────────────────────────────

const symbolPatterns: QueryPattern[] = [
  // class Foo { … }
  {
    query: '(class_declaration name: (identifier) @name) @definition.class',
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
  // const foo = () => { … }  (arrow function assigned to lexical declaration)
  {
    query:
      '(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function))) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // const foo = function() { … }  (function expression assigned to lexical declaration)
  {
    query:
      '(lexical_declaration (variable_declarator name: (identifier) @name value: (function_expression))) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // Method definitions inside classes (getters/setters handled separately)
  {
    query: '(method_definition name: (property_identifier) @name) @definition.method',
    captureLabels: { 'definition.method': 'Method' },
    nameCapture: 'name',
    outerCapture: 'definition.method',
  },
  // Getter inside classes
  {
    query: '(method_definition "get" name: (property_identifier) @name) @definition.property',
    captureLabels: { 'definition.property': 'Property' },
    nameCapture: 'name',
    outerCapture: 'definition.property',
  },
  // Setter inside classes
  {
    query: '(method_definition "set" name: (property_identifier) @name) @definition.property',
    captureLabels: { 'definition.property': 'Property' },
    nameCapture: 'name',
    outerCapture: 'definition.property',
  },
];

// ── Import query patterns ──────────────────────────────────────────────────

const importPatterns: QueryPattern[] = [
  // import { foo, bar } from './baz'
  {
    query:
      '(import_statement (import_clause (named_imports (import_specifier name: (identifier) @name))) (string (string_fragment) @source)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // import foo from './bar'  (default import)
  {
    query:
      '(import_statement (import_clause (identifier) @default_name) (string (string_fragment) @source)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'default_name',
    outerCapture: 'import',
    isImport: true,
  },
  // import foo, { bar } from './baz'  (mixed default + named)
  {
    query:
      '(import_statement (import_clause (identifier) @default_name (named_imports (import_specifier name: (identifier) @name))) (string (string_fragment) @source)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // import * as foo from './bar'
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

export const javascriptLanguage: LanguageDefinition = {
  name: 'javascript',
  extensions: ['.js', '.mjs', '.cjs', '.jsx'],
  wasmFile: 'tree-sitter-javascript.wasm',
  importSemantics: 'named',

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
