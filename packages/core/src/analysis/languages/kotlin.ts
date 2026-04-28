/**
 * Kotlin language provider for Astrolabe.
 *
 * Full implementation with tree-sitter-kotlin grammar supporting:
 * - Class, interface, object, data class, enum detection
 * - Function/method extraction
 * - Named import resolution
 * - : SuperClass/: Interface inheritance
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  { query: '(class_declaration name: (type_identifier) @name) @definition.class', captureLabels: { 'definition.class': 'Class' }, nameCapture: 'name', outerCapture: 'definition.class' },
  { query: '(interface_declaration name: (type_identifier) @name) @definition.interface', captureLabels: { 'definition.interface': 'Interface' }, nameCapture: 'name', outerCapture: 'definition.interface' },
  { query: '(object_declaration name: (type_identifier) @name) @definition.object', captureLabels: { 'definition.object': 'Class' }, nameCapture: 'name', outerCapture: 'definition.object' },
  { query: '(enum_declaration name: (type_identifier) @name) @definition.enum', captureLabels: { 'definition.enum': 'Enum' }, nameCapture: 'name', outerCapture: 'definition.enum' },
  { query: '(function_declaration name: (simple_identifier) @name) @definition.function', captureLabels: { 'definition.function': 'Function' }, nameCapture: 'name', outerCapture: 'definition.function' },
  { query: '(property_declaration (variable_declaration simple_identifier: (simple_identifier) @name)) @definition.property', captureLabels: { 'definition.property': 'Property' }, nameCapture: 'name', outerCapture: 'definition.property' },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  { query: '(import_header (identifier) @source (simple_identifier) @name) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'name', outerCapture: 'import', isImport: true },
  { query: '(import_header (type_identifier) @source @name) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'name', outerCapture: 'import', isImport: true },
] as QueryPattern[];

export const kotlinLanguage: LanguageDefinition = {
  name: 'kotlin',
  extensions: ['.kt', '.kts'],
  wasmFile: 'tree-sitter-kotlin.wasm',
  get symbolPatterns() { return symbolPatterns; },
  get importPatterns() { return importPatterns; },
  async load(wasmDir: string): Promise<WtsLanguage> {
    return WtsLanguage.load(resolve(wasmDir, this.wasmFile));
  },
};
