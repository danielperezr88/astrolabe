/**
 * Go language provider for Astrolabe.
 *
 * Full implementation with tree-sitter-go grammar supporting:
 * - Function/method/struct/interface detection
 * - Import resolution (wildcard-leaf semantics)
 * - Struct embedding (heritage)
 * - Go-specific constructor patterns (NewXxx)
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  // function declarations (top-level and nested)
  {
    query: '(function_declaration name: (identifier) @name body: (block)?) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // method declarations (receiver methods)
  {
    query: '(method_declaration name: (field_identifier) @name body: (block)?) @definition.method',
    captureLabels: { 'definition.method': 'Method' },
    nameCapture: 'name',
    outerCapture: 'definition.method',
  },
  // type declarations — struct
  {
    query: '(type_declaration (type_spec name: (type_identifier) @name type: (struct_type)) @body) @definition.struct',
    captureLabels: { 'definition.struct': 'Struct' },
    nameCapture: 'name',
    outerCapture: 'definition.struct',
  },
  // type declarations — interface
  {
    query: '(type_declaration (type_spec name: (type_identifier) @name type: (interface_type)) @body) @definition.interface',
    captureLabels: { 'definition.interface': 'Interface' },
    nameCapture: 'name',
    outerCapture: 'definition.interface',
  },
  // type declarations — type alias
  {
    query: '(type_declaration (type_spec name: (type_identifier) @name type: (type_identifier) @typeName)) @definition.typealias',
    captureLabels: { 'definition.typealias': 'TypeAlias' },
    nameCapture: 'name',
    outerCapture: 'definition.typealias',
  },
  // short variable declarations (var x = ...)
  {
    query: '(short_var_declaration left: (expression_list (identifier) @name) right: (_)) @definition.variable',
    captureLabels: { 'definition.variable': 'Variable' },
    nameCapture: 'name',
    outerCapture: 'definition.variable',
  },
  // var declarations
  {
    query: '(var_declaration (var_spec name: (identifier) @name)) @definition.variable',
    captureLabels: { 'definition.variable': 'Variable' },
    nameCapture: 'name',
    outerCapture: 'definition.variable',
  },
  // const declarations
  {
    query: '(const_declaration (const_spec name: (identifier) @name)) @definition.const',
    captureLabels: { 'definition.const': 'Const' },
    nameCapture: 'name',
    outerCapture: 'definition.const',
  },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  // import "package"
  {
    query: '(import_spec path: (interpreted_string_literal) @source) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'source',
    outerCapture: 'import',
    isImport: true,
  },
  // import alias "package"
  {
    query: '(import_spec name: (package_identifier) @name path: (interpreted_string_literal) @source) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'source',
    outerCapture: 'import',
    isImport: true,
  },
  // dot import (. "package")
  {
    query: '(import_spec name: (dot) path: (interpreted_string_literal) @source) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'source',
    outerCapture: 'import',
    isImport: true,
  },
] as QueryPattern[];

export const goLanguage: LanguageDefinition = {
  name: 'go',
  extensions: ['.go'],
  wasmFile: 'tree-sitter-go.wasm',
  importSemantics: 'wildcard-leaf',

  get symbolPatterns() { return symbolPatterns; },
  get importPatterns() { return importPatterns; },

  async load(wasmDir: string): Promise<WtsLanguage> {
    return WtsLanguage.load(resolve(wasmDir, this.wasmFile));
  },
};
