/**
 * Astrolabe — Python language definition.
 *
 * Provides tree-sitter query patterns for extracting symbols and imports
 * from Python source files.
 */

import { Language } from 'web-tree-sitter';
import type { Language as WtsLanguage } from 'web-tree-sitter';
import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { resolve } from 'node:path';

// ── Symbol query patterns ──────────────────────────────────────────────────

const symbolPatterns: QueryPattern[] = [
  // def foo():
  {
    query: '(function_definition name: (identifier) @name) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // class Foo:
  {
    query: '(class_definition name: (identifier) @name) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
  },
  // class Foo(Bar):
  {
    query: '(class_definition name: (identifier) @name superclasses: (argument_list (identifier) @base)) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
    relationshipCaptures: { 'base': 'EXTENDS' },
  },
  // async def and def both match function_definition — single pattern covers both
];

// ── Import query patterns ──────────────────────────────────────────────────

const importPatterns: QueryPattern[] = [
  // import foo
  {
    query:
      '(import_statement name: (dotted_name (identifier) @name)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // import foo.bar
  {
    query:
      '(import_statement name: (dotted_name (identifier) @name (identifier) @name)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // import foo as bar (aliased import)
  {
    query:
      '(import_statement name: (aliased_import name: (dotted_name (identifier) @name) alias: (identifier) @alias)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // from foo import bar
  {
    query:
      '(import_from_statement module_name: (dotted_name (identifier) @source) name: (dotted_name (identifier) @name)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // from foo import (bar, baz)
  {
    query:
      '(import_from_statement module_name: (dotted_name (identifier) @source) (dotted_name (identifier) @name)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // from foo import *
  {
    query:
      '(import_from_statement module_name: (dotted_name (identifier) @source) (wildcard_import)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'source',
    outerCapture: 'import',
    isImport: true,
  },
];

// ── Language definition ────────────────────────────────────────────────────

export const pythonLanguage: LanguageDefinition = {
  name: 'python',
  extensions: ['.py', '.pyw'],
  wasmFile: 'tree-sitter-python.wasm',
  importSemantics: 'namespace',

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
