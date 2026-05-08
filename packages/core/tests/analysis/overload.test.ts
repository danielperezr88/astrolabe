/**
 * Tests for overload method disambiguation (#635).
 *
 * Verifies that:
 * - symbolId() produces distinct IDs for same-name methods with different arities
 * - symbolId() produces distinct IDs for same-arity, different-type overloads
 * - Zero-arity functions get no #0 suffix (existing behaviour preserved)
 * - C++ const-qualified methods get \\ suffix
 * - The parser threads parameterTypes into symbolId so graph nodes carry overload suffixes
 * - The dedup key includes parameterTypes so overloaded methods are not collapsed
 * - paramCount is stored in node properties
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initParser,
  resetParser,
  parseFile,
} from '../../src/analysis/parser.js';
import { symbolId } from '../../src/analysis/language-definition.js';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ── Test helpers ────────────────────────────────────────────────────────────

// Resolve wasm directory — works whether vitest runs from project root or packages/core
const wasmDir = existsSync(resolve(process.cwd(), 'packages/core/wasm'))
  ? resolve(process.cwd(), 'packages/core/wasm')
  : resolve(process.cwd(), 'wasm');
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

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'astrolabe-overload-test-'));
  await initParser();
}, 15000);

afterAll(() => {
  resetParser();
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Overload disambiguation (#635)', () => {
  // ── symbolId() unit tests ──────────────────────────────────────────────

  describe('symbolId() — arity suffix', () => {
    it('generates distinct IDs for same-name methods with different parameter counts', () => {
      const id1 = symbolId('Method', 'src/foo.ts', 'save', 10, { parameterCount: 1 });
      const id2 = symbolId('Method', 'src/foo.ts', 'save', 20, { parameterCount: 2 });

      expect(id1).toBe('Method:src/foo.ts:save#1:L10');
      expect(id2).toBe('Method:src/foo.ts:save#2:L20');
      expect(id1).not.toBe(id2);
    });
  });

  describe('symbolId() — type hash suffix', () => {
    it('generates distinct IDs for same-arity, different-type overloads', () => {
      const id1 = symbolId('Method', 'src/foo.ts', 'save', 10, {
        parameterCount: 2,
        parameterTypes: ['int', 'string'],
      });
      const id2 = symbolId('Method', 'src/foo.ts', 'save', 20, {
        parameterCount: 2,
        parameterTypes: ['string', 'int'],
      });

      expect(id1).toBe('Method:src/foo.ts:save#2~int,string:L10');
      expect(id2).toBe('Method:src/foo.ts:save#2~string,int:L20');
      expect(id1).not.toBe(id2);
    });

    it('same parameter types produce same type hash', () => {
      const id1 = symbolId('Method', 'src/foo.ts', 'save', 10, {
        parameterCount: 2,
        parameterTypes: ['int', 'string'],
      });
      const id2 = symbolId('Method', 'src/foo.ts', 'save', 20, {
        parameterCount: 2,
        parameterTypes: ['int', 'string'],
      });

      // Different lines → different IDs, but the overload suffix part is identical
      expect(id1).toContain('#2~int,string');
      expect(id2).toContain('#2~int,string');
    });
  });

  describe('symbolId() — zero-arity gets no suffix', () => {
    it('omits #0 suffix for zero-arity functions', () => {
      const id = symbolId('Function', 'src/foo.ts', 'noop', 1, { parameterCount: 0 });
      expect(id).toBe('Function:src/foo.ts:noop:L1');
      expect(id).not.toContain('#0');
    });

    it('omits suffix entirely when parameterCount is undefined', () => {
      const id = symbolId('Function', 'src/foo.ts', 'noop', 1);
      expect(id).toBe('Function:src/foo.ts:noop:L1');
    });
  });

  describe('symbolId() — C++ const suffix', () => {
    it('appends backslash for const-qualified methods', () => {
      const id = symbolId('Method', 'src/foo.cpp', 'getValue', 5, {
        parameterCount: 0,
        isConst: true,
      });
      // Zero arity → no #N suffix, but \\ still applies
      expect(id).toBe('Method:src/foo.cpp:getValue\\:L5');
    });

    it('appends backslash after type hash for const-qualified methods with params', () => {
      const id = symbolId('Method', 'src/foo.cpp', 'compute', 10, {
        parameterCount: 2,
        parameterTypes: ['int', 'float'],
        isConst: true,
      });
      expect(id).toBe('Method:src/foo.cpp:compute#2~int,float\\:L10');
    });

    it('does not append backslash when isConst is false', () => {
      const id = symbolId('Method', 'src/foo.cpp', 'compute', 10, {
        parameterCount: 2,
        parameterTypes: ['int', 'float'],
        isConst: false,
      });
      expect(id).toBe('Method:src/foo.cpp:compute#2~int,float:L10');
    });
  });

  // ── Full parser pipeline tests ─────────────────────────────────────────

  describe('TypeScript overload parsing', () => {
    let tsOverloadFile: string;

    beforeAll(() => {
      tsOverloadFile = writeFixture(
        'overloads.ts',
        nl(
          'class Renderer {',
          '  draw(shape: string): void {}',
          '  draw(shape: string, color: number): void {}',
          '  draw(shape: string, color: number, bold: boolean): void {}',
          '  clear(): void {}',
          '}',
        ),
      );
    });

    it('produces distinct IDs for methods with different parameter counts', async () => {
      const result = await parseFile(tsOverloadFile, wasmDir);
      const draws = result.symbols.filter((s) => s.name === 'draw');
      expect(draws.length).toBe(3);
      const ids = draws.map((s) => s.id).sort();
      // 1-param, 2-param, 3-param versions
      expect(ids[0]).toContain('#1');
      expect(ids[1]).toContain('#2');
      expect(ids[2]).toContain('#3');
      // All IDs are unique
      expect(new Set(ids).size).toBe(3);
    });

    it('preserves type hash in symbol ID when parameter types are available', async () => {
      const result = await parseFile(tsOverloadFile, wasmDir);
      const twoParam = result.symbols.find(
        (s) => s.name === 'draw' && s.id.includes('#2'),
      );
      expect(twoParam).toBeDefined();
      // Should have #2~string,number or similar type hash
      expect(twoParam!.id).toMatch(/#2~[^:]+/);
    });

    it('zero-arity method gets no #0 suffix', async () => {
      const result = await parseFile(tsOverloadFile, wasmDir);
      const clear = result.symbols.find((s) => s.name === 'clear');
      expect(clear).toBeDefined();
      expect(clear!.id).not.toContain('#0');
    });

    it('paramCount is stored in node properties', async () => {
      const result = await parseFile(tsOverloadFile, wasmDir);
      const twoParam = result.symbols.find(
        (s) => s.name === 'draw' && s.id.includes('#2'),
      );
      expect(twoParam).toBeDefined();
      expect(twoParam!.properties).toBeDefined();
      expect(twoParam!.properties!.paramCount).toBe(2);
    });

    it('overloaded methods are NOT deduplicated', async () => {
      const result = await parseFile(tsOverloadFile, wasmDir);
      const draws = result.symbols.filter((s) => s.name === 'draw');
      // All 3 overloads should survive dedup
      expect(draws.length).toBe(3);
    });
  });

  describe('TypeScript same-arity different-type overloads', () => {
    let tsSameArityFile: string;

    beforeAll(() => {
      tsSameArityFile = writeFixture(
        'same-arity.ts',
        nl(
          'class Calculator {',
          '  add(a: number, b: number): number { return a + b; }',
          '  add(a: string, b: string): string { return a + b; }',
          '}',
        ),
      );
    });

    it('same-arity methods with different types get distinct IDs', async () => {
      const result = await parseFile(tsSameArityFile, wasmDir);
      const adds = result.symbols.filter((s) => s.name === 'add');
      expect(adds.length).toBe(2);
      // Both have #2 but different type hashes
      const ids = adds.map((s) => s.id);
      expect(ids[0]).not.toBe(ids[1]);
      // Both should contain #2
      for (const id of ids) {
        expect(id).toContain('#2');
      }
    });
  });

  // ── C/C++ const method tests (conditional on WASM availability) ──────

  describe.runIf(hasWasm('tree-sitter-cpp.wasm'))('C++ const methods', () => {
    let cppFile: string;

    beforeAll(() => {
      cppFile = writeFixture(
        'const.cpp',
        nl(
          'class Config {',
          '  int getValue() const { return val; }',
          '  void setValue(int v) { val = v; }',
          '  int val;',
          '};',
        ),
      );
    });

    it('const-qualified method gets backslash suffix in ID', async () => {
      const result = await parseFile(cppFile, wasmDir);
      const getValue = result.symbols.find((s) => s.name === 'getValue');
      expect(getValue).toBeDefined();
      // Zero-arity const method → no #N, but has \\ suffix
      expect(getValue!.id).toContain('\\');
    });

    it('non-const method does not get backslash suffix', async () => {
      const result = await parseFile(cppFile, wasmDir);
      const setValue = result.symbols.find((s) => s.name === 'setValue');
      expect(setValue).toBeDefined();
      expect(setValue!.id).not.toContain('\\');
    });
  });
});
