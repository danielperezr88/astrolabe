/**
 * Go language provider for Astrolabe.
 *
 * Skeleton — query patterns will be refined as tree-sitter-go WASM
 * grammar support is added. Currently supports basic detection.
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  // function declarations
  {
    query: '(function_declaration name: (identifier) @name) @definition.function',
    captureLabels: { 'definition.function': 'Function' } as Record<string, any>,
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // method declarations
  {
    query: '(method_declaration name: (field_identifier) @name) @definition.method',
    captureLabels: { 'definition.method': 'Method' },
    nameCapture: 'name',
    outerCapture: 'definition.method',
  },
  // type declarations (struct)
  {
    query: '(type_declaration (type_spec name: (type_identifier) @name type: (struct_type)) @definition.type)',
    captureLabels: { 'definition.type': 'Struct' },
    nameCapture: 'name',
    outerCapture: 'definition.type',
  },
  // interface declarations
  {
    query: '(type_declaration (type_spec name: (type_identifier) @name type: (interface_type)) @definition.type)',
    captureLabels: { 'definition.type': 'Interface' },
    nameCapture: 'name',
    outerCapture: 'definition.type',
  },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  // import "fmt"
  {
    query: '(import_spec path: (interpreted_string_literal) @source) @import',
    captureLabels: { 'import': 'Import' } as Record<string, any>,
    nameCapture: 'source',
    outerCapture: 'import',
    isImport: true,
  },
] as QueryPattern[];

export const goLanguage: LanguageDefinition = {
  name: 'go',
  extensions: ['.go'],
  wasmFile: 'tree-sitter-go.wasm',

  get symbolPatterns() { return symbolPatterns; },
  get importPatterns() { return importPatterns; },

  async load(wasmDir: string): Promise<WtsLanguage> {
    return WtsLanguage.load(resolve(wasmDir, this.wasmFile));
  },
};
