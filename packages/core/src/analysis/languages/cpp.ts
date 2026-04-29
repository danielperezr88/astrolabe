/**
 * C++ language provider for Astrolabe.
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  { query: '(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function', captureLabels: { 'definition.function': 'Function' }, nameCapture: 'name', outerCapture: 'definition.function' },
  { query: '(class_specifier name: (type_identifier) @name) @definition.class', captureLabels: { 'definition.class': 'Class' }, nameCapture: 'name', outerCapture: 'definition.class' },
  { query: '(struct_specifier name: (type_identifier) @name) @definition.struct', captureLabels: { 'definition.struct': 'Struct' }, nameCapture: 'name', outerCapture: 'definition.struct' },
  { query: '(enum_specifier name: (type_identifier) @name) @definition.enum', captureLabels: { 'definition.enum': 'Enum' }, nameCapture: 'name', outerCapture: 'definition.enum' },
  { query: '(template_declaration (function_definition declarator: (function_declarator declarator: (identifier) @name))) @definition.template', captureLabels: { 'definition.template': 'Template' }, nameCapture: 'name', outerCapture: 'definition.template' },
  { query: '(namespace_definition name: (identifier) @name) @definition.namespace', captureLabels: { 'definition.namespace': 'Namespace' }, nameCapture: 'name', outerCapture: 'definition.namespace' },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  { query: '(preproc_include path: (string_literal) @source) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'source', outerCapture: 'import', isImport: true },
  { query: '(preproc_include path: (system_lib_string) @source) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'source', outerCapture: 'import', isImport: true },
] as QueryPattern[];

export const cppLanguage: LanguageDefinition = {
  name: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'], wasmFile: 'tree-sitter-cpp.wasm', importSemantics: 'wildcard-transitive',
  get symbolPatterns() { return symbolPatterns; }, get importPatterns() { return importPatterns; },
  async load(wasmDir: string): Promise<WtsLanguage> { return WtsLanguage.load(resolve(wasmDir, this.wasmFile)); },
};
