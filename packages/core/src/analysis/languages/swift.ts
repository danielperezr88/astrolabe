/**
 * Swift language provider for Astrolabe.
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  { query: '(class_declaration name: (type_identifier) @name) @definition.class', captureLabels: { 'definition.class': 'Class' }, nameCapture: 'name', outerCapture: 'definition.class' },
  { query: '(struct_declaration name: (type_identifier) @name) @definition.struct', captureLabels: { 'definition.struct': 'Struct' }, nameCapture: 'name', outerCapture: 'definition.struct' },
  { query: '(enum_declaration name: (type_identifier) @name) @definition.enum', captureLabels: { 'definition.enum': 'Enum' }, nameCapture: 'name', outerCapture: 'definition.enum' },
  { query: '(protocol_declaration name: (type_identifier) @name) @definition.interface', captureLabels: { 'definition.interface': 'Interface' }, nameCapture: 'name', outerCapture: 'definition.interface' },
  { query: '(function_declaration name: (simple_identifier) @name) @definition.function', captureLabels: { 'definition.function': 'Function' }, nameCapture: 'name', outerCapture: 'definition.function' },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  { query: '(import_declaration (simple_identifier) @name) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'name', outerCapture: 'import', isImport: true },
  { query: '(import_declaration (navigation_suffix (type_identifier) @name)) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'name', outerCapture: 'import', isImport: true },
] as QueryPattern[];

export const swiftLanguage: LanguageDefinition = {
  name: 'swift', extensions: ['.swift'], wasmFile: 'tree-sitter-swift.wasm',
  get symbolPatterns() { return symbolPatterns; }, get importPatterns() { return importPatterns; },
  async load(wasmDir: string): Promise<WtsLanguage> { return WtsLanguage.load(resolve(wasmDir, this.wasmFile)); },
};
