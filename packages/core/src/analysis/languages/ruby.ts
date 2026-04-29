/**
 * Ruby language provider for Astrolabe.
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  { query: '(class name: (constant) @name) @definition.class', captureLabels: { 'definition.class': 'Class' }, nameCapture: 'name', outerCapture: 'definition.class' },
  { query: '(module name: (constant) @name) @definition.module', captureLabels: { 'definition.module': 'Module' }, nameCapture: 'name', outerCapture: 'definition.module' },
  { query: '(method name: (identifier) @name) @definition.method', captureLabels: { 'definition.method': 'Method' }, nameCapture: 'name', outerCapture: 'definition.method' },
  { query: '(singleton_method name: (identifier) @name) @definition.method', captureLabels: { 'definition.method': 'Method' }, nameCapture: 'name', outerCapture: 'definition.method' },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  // #287: Only match require/require_relative calls — avoid false-positive IMPORTS on puts/logger/warn etc.
  { query: '(call method: (identifier) @_method arguments: (argument_list (string) @source)) @import (#match? @_method "^(require|require_relative)$")', captureLabels: { 'import': 'Import' }, nameCapture: 'source', outerCapture: 'import', isImport: true },
] as QueryPattern[];

export const rubyLanguage: LanguageDefinition = {
  name: 'ruby', extensions: ['.rb'], wasmFile: 'tree-sitter-ruby.wasm',   importSemantics: 'wildcard-leaf', mroStrategy: 'first-wins',
  get symbolPatterns() { return symbolPatterns; }, get importPatterns() { return importPatterns; },
  async load(wasmDir: string): Promise<WtsLanguage> { return WtsLanguage.load(resolve(wasmDir, this.wasmFile)); },
};
