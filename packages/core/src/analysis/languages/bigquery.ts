/**
 * Astrolabe — BigQuery (GoogleSQL) language definition.
 *
 * Provides tree-sitter query patterns for extracting symbols and references
 * from BigQuery SQL source files (.sql, .bqsql).
 *
 * Grammar: tree-sitter-sql-bigquery v0.8.0
 *   Repository: github.com/takegue/tree-sitter-sql-bigquery
 *   Status: 121/121 grammar tests pass, 115+ node types, MIT license
 *   WASM: Compiled natively via emsdk 3.1.64 (emcc) from v0.8.0 sources
 *
 * Key grammar nodes used:
 *   - create_table_statement.table_name     → Class (tables, views, mat. views)
 *   - create_function_statement.routine_name → Function
 *   - create_procedure_statement.routine_name → Function
 *   - create_schema_statement.schema_name    → Namespace
 *   - create_model_statement.model_name      → Class (ML models)
 *   - function_call.function                 → CALLS edge
 *   - from_item.table_name                   → Import edge (cross-file ref)
 */

import type { LanguageDefinition, QueryPattern } from '../language-definition.js';
import { Language as WtsLanguage } from 'web-tree-sitter';
import { resolve } from 'node:path';

// ── Symbol query patterns ──────────────────────────────────────────────────

const symbolPatterns: QueryPattern[] = [
  // CREATE TABLE / VIEW / MATERIALIZED VIEW —
  // all share create_table_statement node with kw('TABLE')|kw('VIEW')|kw('MATERIALIZED VIEW')
  {
    query: '(create_table_statement table_name: (identifier) @name) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
  },
  // CREATE TABLE … LIKE …
  {
    query: '(create_table_like_statement table_name: (identifier) @name) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
  },
  // CREATE TABLE … CLONE …
  {
    query: '(create_table_clone_statement table_name: (identifier) @name) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
  },
  // CREATE TABLE … COPY …
  {
    query: '(create_table_copy_statement table_name: (identifier) @name) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
  },
  // CREATE SNAPSHOT TABLE …
  {
    query: '(create_snapshot_table_statement table_name: (identifier) @name) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
  },
  // CREATE EXTERNAL TABLE …
  {
    query: '(create_external_table_statement table_name: (identifier) @name) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
  },
  // CREATE FUNCTION …
  {
    query: '(create_function_statement routine_name: (identifier) @name) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // CREATE REMOTE FUNCTION …
  {
    query: '(create_remote_function_statement routine_name: (identifier) @name) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // CREATE TABLE FUNCTION …
  {
    query: '(create_table_function_statement routine_name: (identifier) @name) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // CREATE PROCEDURE …
  {
    query: '(create_procedure_statement routine_name: (identifier) @name) @definition.function',
    captureLabels: { 'definition.function': 'Function' },
    nameCapture: 'name',
    outerCapture: 'definition.function',
  },
  // CREATE SCHEMA …
  {
    query: '(create_schema_statement schema_name: (identifier) @name) @definition.namespace',
    captureLabels: { 'definition.namespace': 'Namespace' },
    nameCapture: 'name',
    outerCapture: 'definition.namespace',
  },
  // CREATE MODEL …
  {
    query: '(create_model_statement model_name: (identifier) @name) @definition.class',
    captureLabels: { 'definition.class': 'Class' },
    nameCapture: 'name',
    outerCapture: 'definition.class',
  },
];

// ── Import / reference patterns ────────────────────────────────────────────

const importPatterns: QueryPattern[] = [
  // FROM clause table references — treat as cross-file references
  // (from_item table_name: (identifier) @source)
  {
    query: '(from_item table_name: (identifier) @source) @import',
    captureLabels: { 'import': 'Import' },
    nameCapture: 'source',
    outerCapture: 'import',
    isImport: true,
  },
];

// ── Call-site patterns ─────────────────────────────────────────────────────

const callPatterns: QueryPattern[] = [
  // function_call function: (identifier) @call_name
  {
    query: '(function_call function: (identifier) @call_name) @call_site',
    captureLabels: {},
    nameCapture: 'call_name',
    outerCapture: 'call_site',
  },
];

// ── Language definition ────────────────────────────────────────────────────

export const bigqueryLanguage: LanguageDefinition = {
  name: 'bigquery',
  // .sql also maps to BigQuery as the first SQL dialect; future multi-dialect
  // support will need heuristics or a --sql-dialect CLI flag (#940).
  extensions: ['.sql', '.bqsql'],
  wasmFile: 'tree-sitter-bigquery.wasm',

  get symbolPatterns(): QueryPattern[] {
    return symbolPatterns;
  },

  get importPatterns(): QueryPattern[] {
    return importPatterns;
  },

  get callPatterns(): QueryPattern[] {
    return callPatterns;
  },

  importSemantics: 'named',
  // SQL has no method resolution order (no class inheritance)
  mroStrategy: 'none',

  async load(wasmDir: string): Promise<WtsLanguage> {
    const wasmPath = resolve(wasmDir, this.wasmFile);
    return WtsLanguage.load(wasmPath);
  },
};
