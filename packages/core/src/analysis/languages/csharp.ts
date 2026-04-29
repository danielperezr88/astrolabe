/**
 * C# language provider for Astrolabe.
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  { query: '(class_declaration name: (identifier) @name) @definition.class', captureLabels: { 'definition.class': 'Class' }, nameCapture: 'name', outerCapture: 'definition.class' },
  { query: '(interface_declaration name: (identifier) @name) @definition.interface', captureLabels: { 'definition.interface': 'Interface' }, nameCapture: 'name', outerCapture: 'definition.interface' },
  { query: '(struct_declaration name: (identifier) @name) @definition.struct', captureLabels: { 'definition.struct': 'Struct' }, nameCapture: 'name', outerCapture: 'definition.struct' },
  { query: '(enum_declaration name: (identifier) @name) @definition.enum', captureLabels: { 'definition.enum': 'Enum' }, nameCapture: 'name', outerCapture: 'definition.enum' },
  { query: '(record_declaration name: (identifier) @name) @definition.record', captureLabels: { 'definition.record': 'Record' }, nameCapture: 'name', outerCapture: 'definition.record' },
  { query: '(namespace_declaration name: (identifier) @name) @definition.namespace', captureLabels: { 'definition.namespace': 'Namespace' }, nameCapture: 'name', outerCapture: 'definition.namespace' },
  { query: '(method_declaration name: (identifier) @name) @definition.method', captureLabels: { 'definition.method': 'Method' }, nameCapture: 'name', outerCapture: 'definition.method' },
  { query: '(constructor_declaration name: (identifier) @name) @definition.constructor', captureLabels: { 'definition.constructor': 'Constructor' }, nameCapture: 'name', outerCapture: 'definition.constructor' },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  { query: '(using_directive name: (identifier_or_type_name) @name @source) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'name', outerCapture: 'import', isImport: true },
] as QueryPattern[];

export const csharpLanguage: LanguageDefinition = {
  name: 'csharp', extensions: ['.cs'], wasmFile: 'tree-sitter-c-sharp.wasm', importSemantics: 'named',
  get symbolPatterns() { return symbolPatterns; }, get importPatterns() { return importPatterns; },
  async load(wasmDir: string): Promise<WtsLanguage> { return WtsLanguage.load(resolve(wasmDir, this.wasmFile)); },
};
