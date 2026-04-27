/**
 * Rust language provider for Astrolabe.
 *
 * Skeleton — query patterns will be refined as tree-sitter-rust WASM
 * grammar support is added. Currently supports basic detection.
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  // function declarations
  {
    query: '(function_item name: (identifier) @name) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // struct declarations
  {
    query: '(struct_item name: (type_identifier) @name) @definition.struct',
    captureLabels: { 'definition.struct': 'Struct' },
    nameCapture: 'name',
    outerCapture: 'definition.struct',
  },
  // impl blocks
  {
    query: '(impl_item trait: (type_identifier)? type: (type_identifier) @name) @definition.impl',
    captureLabels: { 'definition.impl': 'Impl' },
    nameCapture: 'name',
    outerCapture: 'definition.impl',
  },
  // trait declarations
  {
    query: '(trait_item name: (type_identifier) @name) @definition.trait',
    captureLabels: { 'definition.trait': 'Trait' },
    nameCapture: 'name',
    outerCapture: 'definition.trait',
  },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  // use std::collections::HashMap;
  {
    query: '(use_declaration argument: (scoped_identifier path: (identifier)? name: (identifier) @name)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
] as QueryPattern[];

export const rustLanguage: LanguageDefinition = {
  name: 'rust',
  extensions: ['.rs'],
  wasmFile: 'tree-sitter-rust.wasm',

  get symbolPatterns() { return symbolPatterns; },
  get importPatterns() { return importPatterns; },

  async load(wasmDir: string): Promise<WtsLanguage> {
    return WtsLanguage.load(resolve(wasmDir, this.wasmFile));
  },
};
