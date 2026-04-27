/**
 * Rust language provider for Astrolabe.
 *
 * Full implementation with tree-sitter-rust grammar supporting:
 * - Function/struct/enum/trait/impl detection
 * - use statement import resolution (named imports)
 * - Trait implementations and method resolution
 * - Macro and const detection
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  // Methods inside impl blocks — must be BEFORE top-level function_item (#135)
  {
    query: '(impl_item (function_item name: (identifier) @name body: (block)?) @definition.method)',
    captureLabels: { 'definition.method': 'Method' },
    nameCapture: 'name',
    outerCapture: 'definition.method',
  },
  // function declarations (top-level, non-impl)
  {
    query: '(function_item name: (identifier) @name body: (block)?) @definition.function',
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
  // enum declarations
  {
    query: '(enum_item name: (type_identifier) @name) @definition.enum',
    captureLabels: { 'definition.enum': 'Enum' },
    nameCapture: 'name',
    outerCapture: 'definition.enum',
  },
  // trait declarations
  {
    query: '(trait_item name: (type_identifier) @name) @definition.trait',
    captureLabels: { 'definition.trait': 'Trait' },
    nameCapture: 'name',
    outerCapture: 'definition.trait',
  },
  // impl blocks (inherent + trait impls)
  {
    query: '(impl_item type: (type_identifier) @name) @definition.impl',
    captureLabels: { 'definition.impl': 'Impl' },
    nameCapture: 'name',
    outerCapture: 'definition.impl',
  },
  // trait implementations (impl TraitName for TypeName)
  {
    query: '(impl_item trait: (type_identifier) @traitName type: (type_identifier) @name) @definition.impl',
    captureLabels: { 'definition.impl': 'Impl' },
    nameCapture: 'name',
    outerCapture: 'definition.impl',
  },
  // type aliases
  {
    query: '(type_item name: (type_identifier) @name) @definition.typealias',
    captureLabels: { 'definition.typealias': 'TypeAlias' },
    nameCapture: 'name',
    outerCapture: 'definition.typealias',
  },
  // const declarations
  {
    query: '(const_item name: (identifier) @name) @definition.const',
    captureLabels: { 'definition.const': 'Const' },
    nameCapture: 'name',
    outerCapture: 'definition.const',
  },
  // static declarations
  {
    query: '(static_item name: (identifier) @name) @definition.static',
    captureLabels: { 'definition.static': 'Static' },
    nameCapture: 'name',
    outerCapture: 'definition.static',
  },
  // macro definitions (macro_rules!)
  {
    query: '(macro_definition name: (identifier) @name) @definition.macro',
    captureLabels: { 'definition.macro': 'Macro' },
    nameCapture: 'name',
    outerCapture: 'definition.macro',
  },
  // module declarations
  {
    query: '(mod_item name: (identifier) @name) @definition.module',
    captureLabels: { 'definition.module': 'Module' },
    nameCapture: 'name',
    outerCapture: 'definition.module',
  },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  // use crate::module::Type
  {
    query: '(use_declaration argument: (scoped_identifier path: (_)* name: (identifier) @name)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // use module::Type as Alias
  {
    query: '(use_declaration argument: (use_as_clause path: (_)* name: (identifier) @name alias: (identifier) @alias)) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'name',
    outerCapture: 'import',
    isImport: true,
  },
  // use module::{Type1, Type2}
  {
    query: '(use_declaration argument: (use_list (identifier) @name)) @import',
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
