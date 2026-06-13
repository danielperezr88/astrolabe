/**
 * Tests for BigQuery (GoogleSQL) language parsing and symbol extraction.
 *
 * Verifies tree-sitter-sql-bigquery v0.8.0 WASM grammar integration:
 * - DDL symbol extraction (CREATE TABLE / VIEW / FUNCTION / PROCEDURE / SCHEMA)
 * - Function call extraction (CALLS edges)
 * - FROM clause table reference extraction (Import edges)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initParser, resetParser, parseFile } from '../../src/analysis/parser.js';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FileParseResult } from '../../src/analysis/language-definition.js';

// ── Test helpers ────────────────────────────────────────────────────────────

const wasmDir = resolve(process.cwd(), 'wasm');
let tmpDir: string;

function hasWasm(file: string): boolean {
  return existsSync(join(wasmDir, file));
}

function writeFixture(relativePath: string, content: string): string {
  const fullPath = join(tmpDir, relativePath);
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function nl(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

/** Shorthand: parseFile with wasmDir baked in. */
async function parse(path: string): Promise<FileParseResult> {
  return parseFile(path, wasmDir);
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'astrolabe-bigquery-test-'));
  await initParser();
}, 15000);

afterAll(() => {
  resetParser();
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Helper: extract symbol names from parse result ─────────────────────────

function symbolNames(result: FileParseResult, label?: string): string[] {
  return result.symbols
    .filter((s) => !label || s.label === label)
    .map((s) => s.name);
}

function importSources(result: FileParseResult): string[] {
  return result.imports.map((i) => i.source);
}

function callSiteNames(result: FileParseResult): string[] {
  return (result.callSites ?? []).map((c) => c.name);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('BigQuery language support', () => {
  it('WASM grammar file exists', () => {
    expect(hasWasm('tree-sitter-bigquery.wasm')).toBe(true);
  });

  describe('file extension detection', () => {
    it('parses .sql files as bigquery', async () => {
      writeFixture('test.sql', nl('SELECT 1'));
      const result = await parse(join(tmpDir, 'test.sql'));
      expect(result.language).toBe('bigquery');
      expect(result.error).toBeUndefined();
    });

    it('parses .bqsql files as bigquery', async () => {
      writeFixture('test.bqsql', nl('SELECT 1'));
      const result = await parse(join(tmpDir, 'test.bqsql'));
      expect(result.language).toBe('bigquery');
      expect(result.error).toBeUndefined();
    });
  });

  describe('DDL symbol extraction', () => {
    it('extracts CREATE TABLE as Class', async () => {
      const path = writeFixture('ddl.sql', nl(
        'CREATE TABLE users (',
        '  id INT64,',
        '  name STRING',
        ');',
      ));
      const result = await parse(path);
      expect(symbolNames(result, 'Class')).toContain('users');
    });

    it('extracts CREATE TABLE IF NOT EXISTS as Class', async () => {
      const path = writeFixture('ddl.sql', nl(
        'CREATE TABLE IF NOT EXISTS orders (',
        '  id INT64,',
        '  total NUMERIC',
        ');',
      ));
      const result = await parse(path);
      expect(symbolNames(result, 'Class')).toContain('orders');
    });

    it('extracts CREATE VIEW as Class', async () => {
      const path = writeFixture('ddl.sql', nl(
        'CREATE VIEW active_users AS',
        'SELECT * FROM users WHERE active = true',
      ));
      const result = await parse(path);
      // VIEW shares create_table_statement node → Class label
      expect(symbolNames(result, 'Class')).toContain('active_users');
    });

    it('extracts CREATE FUNCTION as Function', async () => {
      const path = writeFixture('ddl.sql', nl(
        'CREATE FUNCTION add_one(x INT64) AS (x + 1)',
      ));
      const result = await parse(path);
      expect(symbolNames(result, 'Function')).toContain('add_one');
    });

    it('extracts CREATE PROCEDURE as Function', async () => {
      const path = writeFixture('ddl.sql', nl(
        'CREATE PROCEDURE refresh_data()',
        'BEGIN',
        '  SELECT 1;',
        'END;',
      ));
      const result = await parse(path);
      expect(symbolNames(result, 'Function')).toContain('refresh_data');
    });

    it('extracts CREATE SCHEMA as Namespace', async () => {
      const path = writeFixture('ddl.sql', nl(
        'CREATE SCHEMA analytics',
      ));
      const result = await parse(path);
      expect(symbolNames(result, 'Namespace')).toContain('analytics');
    });

    it('extracts multiple DDL statements in one file', async () => {
      const path = writeFixture('ddl.sql', nl(
        'CREATE TABLE customers (id INT64);',
        'CREATE FUNCTION get_name(cid INT64) AS (',
        '  SELECT name FROM customers WHERE id = cid',
        ');',
        'CREATE PROCEDURE cleanup() BEGIN END;',
      ));
      const result = await parse(path);
      const classes = symbolNames(result, 'Class');
      const functions = symbolNames(result, 'Function');
      expect(classes).toContain('customers');
      expect(functions).toContain('get_name');
      expect(functions).toContain('cleanup');
    });
  });

  describe('function call extraction', () => {
    it('extracts function_call as call site', async () => {
      const path = writeFixture('query.sql', nl(
        'SELECT COUNT(*), SUM(amount) FROM orders',
      ));
      const result = await parse(path);
      const calls = callSiteNames(result);
      expect(calls).toContain('COUNT');
      expect(calls).toContain('SUM');
    });
  });

  describe('FROM clause references', () => {
    it('extracts FROM clause tables as imports', async () => {
      const path = writeFixture('query.sql', nl(
        'SELECT * FROM orders',
        'JOIN customers ON orders.cust_id = customers.id',
      ));
      const result = await parse(path);
      const imports = importSources(result);
      expect(imports).toContain('orders');
      expect(imports).toContain('customers');
    });
  });

  describe('error tolerance', () => {
    it('handles invalid SQL gracefully', async () => {
      const path = writeFixture('bad.sql', nl(
        'CREATE TABLE;',
      ));
      const result = await parse(path);
      // Tree-sitter may produce ERROR nodes but shouldn't crash
      expect(result.language).toBe('bigquery');
    });
  });
});
