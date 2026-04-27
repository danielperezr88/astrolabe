/**
 * C language provider for Astrolabe.
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  { query: '(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function', captureLabels: { 'definition.function': 'Function' }, nameCapture: 'name', outerCapture: 'definition.function' },
  { query: '(struct_specifier name: (type_identifier) @name) @definition.struct', captureLabels: { 'definition.struct': 'Struct' }, nameCapture: 'name', outerCapture: 'definition.struct' },
  { query: '(enum_specifier name: (type_identifier) @name) @definition.enum', captureLabels: { 'definition.enum': 'Enum' }, nameCapture: 'name', outerCapture: 'definition.enum' },
  { query: '(union_specifier name: (type_identifier) @name) @definition.union', captureLabels: { 'definition.union': 'Union' }, nameCapture: 'name', outerCapture: 'definition.union' },
  { query: '(type_definition declarator: (type_identifier) @name) @definition.typedef', captureLabels: { 'definition.typedef': 'Typedef' }, nameCapture: 'name', outerCapture: 'definition.typedef' },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  { query: '(preproc_include path: (string_literal) @source) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'source', outerCapture: 'import', isImport: true },
  { query: '(preproc_include path: (system_lib_string) @source) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'source', outerCapture: 'import', isImport: true },
] as QueryPattern[];

export const cLanguage: LanguageDefinition = {
  name: 'c', extensions: ['.c', '.h'], wasmFile: 'tree-sitter-c.wasm',
  get symbolPatterns() { return symbolPatterns; }, get importPatterns() { return importPatterns; },
  async load(wasmDir: string): Promise<WtsLanguage> { return WtsLanguage.load(resolve(wasmDir, this.wasmFile)); },
};
