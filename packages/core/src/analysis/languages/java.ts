/**
 * Java language provider for Astrolabe.
 *
 * Full implementation with tree-sitter-java grammar supporting:
 * - Class, interface, enum, annotation detection
 * - Method/constructor extraction
 * - Named/wildcard/static import resolution
 * - extends/implements inheritance
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  { query: '(class_declaration name: (identifier) @name) @definition.class', captureLabels: { 'definition.class': 'Class' }, nameCapture: 'name', outerCapture: 'definition.class' },
  { query: '(class_declaration name: (identifier) @name (superclass (type_identifier) @base)) @definition.class', captureLabels: { 'definition.class': 'Class' }, nameCapture: 'name', outerCapture: 'definition.class', relationshipCaptures: { 'base': 'EXTENDS' } },
  { query: '(class_declaration name: (identifier) @name (super_interfaces (type_list (type_identifier) @implements))) @definition.class', captureLabels: { 'definition.class': 'Class' }, nameCapture: 'name', outerCapture: 'definition.class', relationshipCaptures: { 'implements': 'IMPLEMENTS' } },
  { query: '(interface_declaration name: (identifier) @name) @definition.interface', captureLabels: { 'definition.interface': 'Interface' }, nameCapture: 'name', outerCapture: 'definition.interface' },
  { query: '(enum_declaration name: (identifier) @name) @definition.enum', captureLabels: { 'definition.enum': 'Enum' }, nameCapture: 'name', outerCapture: 'definition.enum' },
  { query: '(annotation_type_declaration name: (identifier) @name) @definition.annotation', captureLabels: { 'definition.annotation': 'Annotation' }, nameCapture: 'name', outerCapture: 'definition.annotation' },
  { query: '(method_declaration name: (identifier) @name) @definition.method', captureLabels: { 'definition.method': 'Method' }, nameCapture: 'name', outerCapture: 'definition.method' },
  { query: '(constructor_declaration name: (identifier) @name) @definition.constructor', captureLabels: { 'definition.constructor': 'Constructor' }, nameCapture: 'name', outerCapture: 'definition.constructor' },
  { query: '(field_declaration declarator: (variable_declarator name: (identifier) @name)) @definition.variable', captureLabels: { 'definition.variable': 'Variable' }, nameCapture: 'name', outerCapture: 'definition.variable' },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  { query: '(import_declaration (scoped_identifier) @name @source) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'name', outerCapture: 'import', isImport: true },
  { query: '(import_declaration (scoped_identifier) @name @source (asterisk)) @import', captureLabels: { 'import': 'Import' }, nameCapture: 'name', outerCapture: 'import', isImport: true },
] as QueryPattern[];

export const javaLanguage: LanguageDefinition = {
  name: 'java',
  extensions: ['.java'],
  wasmFile: 'tree-sitter-java.wasm',
  importSemantics: 'named', mroStrategy: 'first-wins',
  get symbolPatterns() { return symbolPatterns; },
  get importPatterns() { return importPatterns; },
  async load(wasmDir: string): Promise<WtsLanguage> {
    return WtsLanguage.load(resolve(wasmDir, this.wasmFile));
  },
};
