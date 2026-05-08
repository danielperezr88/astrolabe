/**
 * Protobuf language provider for Astrolabe.
 *
 * Full implementation with tree-sitter-proto grammar (coder3101/tree-sitter-proto)
 * supporting proto2 and proto3:
 * - Message, enum, service, oneof detection
 * - RPC method extraction
 * - Import resolution (named)
 * - Package/namespace extraction
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

const symbolPatterns: QueryPattern[] = [
  // message declarations
  {
    query: '(message (identifier) @name) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
  },
  // enum declarations
  {
    query: '(enum (identifier) @name) @definition.enum',
    captureLabels: { 'definition.enum': 'Enum' },
    nameCapture: 'name',
    outerCapture: 'definition.enum',
  },
  // service declarations
  {
    query: '(service (identifier) @name) @definition.interface',
    captureLabels: { 'definition.interface': 'Interface' },
    nameCapture: 'name',
    outerCapture: 'definition.interface',
  },
  // RPC method declarations
  {
    query: '(rpc (identifier) @name) @definition.method',
    captureLabels: { 'definition.method': 'Method' },
    nameCapture: 'name',
    outerCapture: 'definition.method',
  },
  // field declarations (message fields)
  {
    query: '(field (identifier) @name) @definition.property',
    captureLabels: { 'definition.property': 'Property' },
    nameCapture: 'name',
    outerCapture: 'definition.property',
  },
  // oneof declarations
  {
    query: '(oneof (identifier) @name) @definition.union',
    captureLabels: { 'definition.union': 'Union' },
    nameCapture: 'name',
    outerCapture: 'definition.union',
  },
  // package declaration
  {
    query: '(package (full_ident) @name) @definition.namespace',
    captureLabels: { 'definition.namespace': 'Namespace' },
    nameCapture: 'name',
    outerCapture: 'definition.namespace',
  },
] as QueryPattern[];

const importPatterns: QueryPattern[] = [
  // import "path/to/file.proto"
  {
    query: '(import path: (string) @source) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'source',
    outerCapture: 'import',
    isImport: true,
  },
] as QueryPattern[];

export const protobufLanguage: LanguageDefinition = {
  name: 'protobuf',
  extensions: ['.proto'],
  wasmFile: 'tree-sitter-proto.wasm',
  importSemantics: 'named',
  mroStrategy: 'none',

  get symbolPatterns() { return symbolPatterns; },
  get importPatterns() { return importPatterns; },

  async load(wasmDir: string): Promise<WtsLanguage> {
    return WtsLanguage.load(resolve(wasmDir, this.wasmFile));
  },
};
