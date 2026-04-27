/**
 * PHP language provider for Astrolabe.
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  { query: '(class_declaration name: (name) @name) @definition.class', captureLabels: { 'definition.class': 'Class' }, nameCapture: 'name', outerCapture: 'definition.class' },
  { query: '(interface_declaration name: (name) @name) @definition.interface', captureLabels: { 'definition.interface': 'Interface' }, nameCapture: 'name', outerCapture: 'definition.interface' },
  { query: '(trait_declaration name: (name) @name) @definition.trait', captureLabels: { 'definition.trait': 'Trait' }, nameCapture: 'name', outerCapture: 'definition.trait' },
  { query: '(enum_declaration name: (name) @name) @definition.enum', captureLabels: { 'definition.enum': 'Enum' }, nameCapture: 'name', outerCapture: 'definition.enum' },
  { query: '(function_definition name: (name) @name) @definition.function', captureLabels: { 'definition.function': 'Function' }, nameCapture: 'name', outerCapture: 'definition.function' },
  { query: '(method_declaration name: (name) @name) @definition.method', captureLabels: { 'definition.method': 'Method' }, nameCapture: 'name', outerCapture: 'definition.method' },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  { query: '(use_declaration name: (name) @name) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'name', outerCapture: 'import', isImport: true },
] as QueryPattern[];

export const phpLanguage: LanguageDefinition = {
  name: 'php', extensions: ['.php'], wasmFile: 'tree-sitter-php.wasm',
  get symbolPatterns() { return symbolPatterns; }, get importPatterns() { return importPatterns; },
  async load(wasmDir: string): Promise<WtsLanguage> { return WtsLanguage.load(resolve(wasmDir, this.wasmFile)); },
};
