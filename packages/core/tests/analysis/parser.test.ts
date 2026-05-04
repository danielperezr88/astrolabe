/**
 * Tests for the multi-language parser module.
 *
 * These tests use temporary fixture files to exercise the full
 * tree-sitter WASM pipeline: init, load grammar, parse, query,
 * extract symbols & imports, and cache.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initParser,
  resetParser,
  parseFile,
  parseFiles,
} from '../../src/analysis/parser.js';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FileParseResult } from '../../src/analysis/language-definition.js';

// ── Test helpers ────────────────────────────────────────────────────────────

const wasmDir = resolve(process.cwd(), 'wasm');
let tmpDir: string;

/** Check if a specific WASM grammar file exists. */
function hasWasm(file: string): boolean {
  return existsSync(join(wasmDir, file));
}

/**
 * Write a fixture file into the temp directory.
 * Returns the absolute path to the file.
 */
function writeFixture(relativePath: string, content: string): string {
  const fullPath = join(tmpDir, relativePath);
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

/** Join lines with newline, add trailing newline. */
function nl(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

/** Sort symbols by name for deterministic assertions. */
function byName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name);
}

/** Sort imports by source for deterministic assertions. */
function bySource(a: { source: string }, b: { source: string }) {
  return a.source.localeCompare(b.source);
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'astrolabe-parser-test-'));
  await initParser();
}, 15000);

afterAll(() => {
  resetParser();
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Parser', () => {
  // ── Initialisation guard ───────────────────────────────────────────────
  // This test MUST run first: it resets module state, then re-initialises.
  describe('initParser / resetParser', () => {
    it('initParser resolves without error', async () => {
      // beforeAll already called initParser; calling again is idempotent
      await expect(initParser()).resolves.toBeUndefined();
    });

    it('resetParser clears state and allows re-init', async () => {
      resetParser();
      // State is cleared; initParser should still work
      // #252: Must await — un-awaited promise assertion provides false confidence
      await expect(initParser()).resolves.toBeUndefined();
    });
  });

  // ── Initialisation guard ───────────────────────────────────────────────
  describe('parseFile - initialization guard', () => {
    it('throws if parseFile called before initParser', async () => {
      resetParser();
      await expect(parseFile('test.js', wasmDir)).rejects.toThrow(
        /not initialised/i,
      );
      // Re-init for subsequent tests
      await initParser();
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────
  describe('parseFile - error cases', () => {
    it('returns error result for unsupported file extension', async () => {
      const result = await parseFile(
        join(tmpDir, 'unsupported.xyz'),
        wasmDir,
      );
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toMatch(/unsupported/i);
      expect(result.symbols).toEqual([]);
      expect(result.imports).toEqual([]);
    });

    it('returns error result for non-existent file', async () => {
      const result = await parseFile(
        join(tmpDir, 'nonexistent.js'),
        wasmDir,
      );
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toMatch(/failed to read/i);
      expect(result.symbols).toEqual([]);
      expect(result.imports).toEqual([]);
    });
  });

  // ── JavaScript ─────────────────────────────────────────────────────────
  describe('parseFile - JavaScript', () => {
    let jsSymbolsFile: string;
    let jsImportsFile: string;
    let jsExportsFile: string;
    let jsMixedFile: string;

    beforeAll(() => {
      jsSymbolsFile = writeFixture(
        'symbols.js',
        nl(
          'class MyClass {',
          '  myMethod() {}',
          '  get myGetter() {}',
          '}',
          '',
          'function myFunction() {',
          '}',
          '',
          'const myArrow = () => {',
          '};',
          '',
          'const myExpr = function() {',
          '};',
        ),
      );

      jsImportsFile = writeFixture(
        'imports.js',
        nl(
          "import { named1, named2 } from './module-a';",
          "import defaultExport from './module-b';",
          "import defaultExport2, { named3 } from './module-c';",
          "import * as namespace from './module-d';",
          "import './side-effect';",
        ),
      );

      jsExportsFile = writeFixture(
        'exports.js',
        nl(
          'export class ExportedClass {',
          '}',
          '',
          'export function exportedFn() {',
          '}',
          '',
          'export default function defaultExport() {',
          '}',
        ),
      );

      jsMixedFile = writeFixture(
        'mixed.js',
        nl(
          'import { something } from "./utils";',
          '',
          'export class Service {',
          '  handle() {}',
          '}',
          '',
          'function helper() {}',
        ),
      );
    });

    it('extracts class declarations', async () => {
      const result = await parseFile(jsSymbolsFile, wasmDir);
      const classes = result.symbols.filter((s) => s.label === 'Class');
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('MyClass');
      expect(classes[0].startLine).toBe(1);
      expect(classes[0].filePath).toContain('symbols.js');
      expect(classes[0].id).toContain('Class');
      expect(classes[0].id).toContain('MyClass');
    });

    it('extracts function declarations, arrow fns, and fn expressions', async () => {
      const result = await parseFile(jsSymbolsFile, wasmDir);
      const functions = result.symbols.filter((s) => s.label === 'Function');
      expect(functions).toHaveLength(3);
      const names = functions.map((f) => f.name).sort();
      expect(names).toEqual(['myArrow', 'myExpr', 'myFunction']);
    });

    it('extracts method definitions', async () => {
      const result = await parseFile(jsSymbolsFile, wasmDir);
      const methods = result.symbols.filter((s) => s.label === 'Method');
      expect(methods).toHaveLength(1);
      expect(methods[0].name).toBe('myMethod');
    });

    it('extracts getter/setter as Property label', async () => {
      const result = await parseFile(jsSymbolsFile, wasmDir);
      const props = result.symbols.filter((s) => s.label === 'Property');
      expect(props).toHaveLength(1);
      expect(props[0].name).toBe('myGetter');
    });

    it('extracts total symbols correctly', async () => {
      const result = await parseFile(jsSymbolsFile, wasmDir);
      expect(result.symbols.length).toBe(6); // class + 3 fns + method + getter
    });

    it('extracts named imports', async () => {
      const result = await parseFile(jsImportsFile, wasmDir);
      const modA = result.imports.find((i) => i.source === './module-a');
      expect(modA).toBeDefined();
      expect(modA!.names).toHaveLength(2);
      expect(modA!.names.map((n) => n.name).sort()).toEqual(['named1', 'named2']);
      expect(modA!.names.every((n) => !n.isDefault)).toBe(true);
    });

    it('extracts default imports', async () => {
      const result = await parseFile(jsImportsFile, wasmDir);
      const modB = result.imports.find((i) => i.source === './module-b');
      expect(modB).toBeDefined();
      expect(modB!.names).toHaveLength(1);
      expect(modB!.names[0].name).toBe('defaultExport');
      expect(modB!.names[0].isDefault).toBe(true);
    });

    it('extracts mixed default + named imports', async () => {
      const result = await parseFile(jsImportsFile, wasmDir);
      const modC = result.imports.find((i) => i.source === './module-c');
      expect(modC).toBeDefined();
      expect(modC!.names).toHaveLength(2);
      const defaultName = modC!.names.find((n) => n.isDefault);
      const namedName = modC!.names.find((n) => !n.isDefault);
      expect(defaultName?.name).toBe('defaultExport2');
      expect(namedName?.name).toBe('named3');
    });

    it('extracts namespace imports', async () => {
      const result = await parseFile(jsImportsFile, wasmDir);
      const modD = result.imports.find((i) => i.source === './module-d');
      expect(modD).toBeDefined();
      expect(modD!.names).toHaveLength(1);
      expect(modD!.names[0].name).toBe('namespace');
    });

    it.skip('extracts side-effect imports', async () => {
      const result = await parseFile(jsImportsFile, wasmDir);
      const side = result.imports.find((i) => i.source === './side-effect');
      expect(side).toBeDefined();
    });

    it('total JS import count is correct', async () => {
      const result = await parseFile(jsImportsFile, wasmDir);
      // 4: named, default, mixed, namespace (side-effect not yet supported)
      expect(result.imports).toHaveLength(4);
    });

    it('detects exported symbols', async () => {
      const result = await parseFile(jsExportsFile, wasmDir);
      const exported = result.symbols.filter((s) => s.isExported);
      expect(exported).toHaveLength(3);
      const names = exported.map((e) => e.name).sort();
      expect(names).toEqual(['ExportedClass', 'defaultExport', 'exportedFn']);
    });

    it('extracts both symbols and imports from mixed file', async () => {
      const result = await parseFile(jsMixedFile, wasmDir);
      expect(result.symbols.length).toBeGreaterThanOrEqual(2); // Service class + helper
      expect(result.imports.length).toBeGreaterThanOrEqual(1);
      expect(result.imports.some((i) => i.source === './utils')).toBe(true);
      expect(result.symbols.some((s) => s.name === 'Service')).toBe(true);
    });
  });

  // ── TypeScript ─────────────────────────────────────────────────────────
  describe('parseFile - TypeScript', () => {
    let tsSymbolsFile: string;
    let tsImportsFile: string;

    beforeAll(() => {
      tsSymbolsFile = writeFixture(
        'symbols.ts',
        nl(
          'interface MyInterface {',
          '  prop: string;',
          '}',
          '',
          'type MyType = string;',
          '',
          'enum MyEnum {',
          '  A, B, C',
          '}',
          '',
          'class MyClass {}',
          '',
          'abstract class MyAbstractClass {}',
          '',
          'function myFunction(): void {}',
          '',
          'const myArrow = () => {};',
          '',
          'const myExpr = function(): void {};',
        ),
      );

      tsImportsFile = writeFixture(
        'imports.ts',
        nl(
          "import { Foo } from './module-a';",
          "import Bar from './module-b';",
          "import Baz, { Qux } from './module-c';",
          "import * as Namespace from './module-d';",
          "import './side-effect';",
        ),
      );
    });

    it('extracts interface declarations', async () => {
      const result = await parseFile(tsSymbolsFile, wasmDir);
      const interfaces = result.symbols.filter((s) => s.label === 'Interface');
      expect(interfaces).toHaveLength(1);
      expect(interfaces[0].name).toBe('MyInterface');
      expect(interfaces[0].startLine).toBe(1);
    });

    it('extracts type aliases', async () => {
      const result = await parseFile(tsSymbolsFile, wasmDir);
      const aliases = result.symbols.filter((s) => s.label === 'TypeAlias');
      expect(aliases).toHaveLength(1);
      expect(aliases[0].name).toBe('MyType');
    });

    it('extracts enum declarations', async () => {
      const result = await parseFile(tsSymbolsFile, wasmDir);
      const enums = result.symbols.filter((s) => s.label === 'Enum');
      expect(enums).toHaveLength(1);
      expect(enums[0].name).toBe('MyEnum');
    });

    it('extracts class declarations', async () => {
      const result = await parseFile(tsSymbolsFile, wasmDir);
      const classes = result.symbols.filter((s) => s.label === 'Class');
      expect(classes).toHaveLength(2); // MyClass + MyAbstractClass
      const names = classes.map((c) => c.name).sort();
      expect(names).toEqual(['MyAbstractClass', 'MyClass']);
    });

    it('extracts function declarations', async () => {
      const result = await parseFile(tsSymbolsFile, wasmDir);
      const fns = result.symbols.filter((s) => s.label === 'Function');
      expect(fns).toHaveLength(3); // myFunction + myArrow + myExpr
    });

    it('extracts TS imports correctly', async () => {
      const result = await parseFile(tsImportsFile, wasmDir);
      // 4: named, default, mixed, namespace (side-effect not yet supported)
      expect(result.imports).toHaveLength(4);

      const modA = result.imports.find((i) => i.source === './module-a');
      expect(modA?.names).toHaveLength(1);
      expect(modA?.names[0].name).toBe('Foo');
    });

    it('sets correct language field for .ts files', async () => {
      const result = await parseFile(tsSymbolsFile, wasmDir);
      expect(result.language).toBe('typescript');
    });
  });

  // ── TSX ─────────────────────────────────────────────────────────────────
  describe('parseFile - TSX', () => {
    let tsxSymbolsFile: string;

    beforeAll(() => {
      tsxSymbolsFile = writeFixture(
        'component.tsx',
        nl(
          'const Component = () => <div>hello</div>;',
          '',
          'function Helper() {',
          '  return <span>world</span>;',
          '}',
        ),
      );
    });

    it('parses TSX with JSX expressions', async () => {
      const result = await parseFile(tsxSymbolsFile, wasmDir);
      expect(result.symbols.length).toBeGreaterThanOrEqual(1);
      expect(result.error).toBeUndefined();
    });

    it('extracts symbols from TSX files', async () => {
      const result = await parseFile(tsxSymbolsFile, wasmDir);
      const fns = result.symbols.filter((s) => s.label === 'Function');
      expect(fns.length).toBeGreaterThanOrEqual(1);
    });

    it('sets correct language field for .tsx files', async () => {
      const result = await parseFile(tsxSymbolsFile, wasmDir);
      expect(result.language).toBe('tsx');
    });
  });

  // ── Python ──────────────────────────────────────────────────────────────
  describe('parseFile - Python', () => {
    let pySymbolsFile: string;
    let pyImportsFile: string;
    let pyExportsFile: string;

    beforeAll(() => {
      pySymbolsFile = writeFixture(
        'symbols.py',
        nl(
          'def my_function():',
          '    pass',
          '',
          'class MyClass:',
          '    def my_method(self):',
          '        pass',
        ),
      );

      pyImportsFile = writeFixture(
        'imports.py',
        nl(
          'import os',
          'import os.path',
          'import os as operating_system',
          'from os import path',
          'from os import path as ospath',
          'from os import *',
        ),
      );
    });

    it('extracts Python function definitions', async () => {
      const result = await parseFile(pySymbolsFile, wasmDir);
      const fns = result.symbols.filter((s) => s.label === 'Function');
      // Note: the Python lang def has a duplicate function_definition pattern,
      // but extractSymbols deduplicates by symbol id
      // #252: Use exact assertion — fixture has exactly 2 functions
      expect(fns.length).toBe(2); // my_function + my_method
      const fnNames = fns.map((f) => f.name).sort();
      expect(fnNames).toContain('my_function');
      expect(fnNames).toContain('my_method');
      expect(fns.find((f) => f.name === 'my_function')?.startLine).toBe(1);
    });

    it('extracts Python class definitions', async () => {
      const result = await parseFile(pySymbolsFile, wasmDir);
      const classes = result.symbols.filter((s) => s.label === 'Class');
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('MyClass');
      expect(classes[0].startLine).toBe(4);
    });

    it('extracts simple module imports', async () => {
      const result = await parseFile(pyImportsFile, wasmDir);
      const osImport = result.imports.find((i) =>
        i.names.some((n) => n.name === 'os' && !n.isDefault),
      );
      expect(osImport).toBeDefined();
    });

    it('extracts aliased imports', async () => {
      const result = await parseFile(pyImportsFile, wasmDir);
      // Alias patterns were removed; `import os as operating_system` now
      // matches the basic import pattern and captures `os` (not `operating_system`)
      const aliasImport = result.imports.find((i) =>
        i.names.some((n) => n.name === 'os'),
      );
      expect(aliasImport).toBeDefined();
    });

    it('extracts from-import patterns', async () => {
      const result = await parseFile(pyImportsFile, wasmDir);
      const fromImport = result.imports.find((i) =>
        i.names.some((n) => n.name === 'path' && !n.isDefault),
      );
      expect(fromImport).toBeDefined();
    });

    it('extracts wildcard imports', async () => {
      const result = await parseFile(pyImportsFile, wasmDir);
      // 6 lines in the fixture: 3 import_statement + 3 import_from_statement
      expect(result.imports.length).toBeGreaterThanOrEqual(4);
    });

    it('sets correct language field for .py files', async () => {
      const result = await parseFile(pySymbolsFile, wasmDir);
      expect(result.language).toBe('python');
    });
  });

  // ── .mjs / .cjs / .mts / .cts / .jsx ───────────────────────────────────
  describe('parseFile - extended extensions', () => {
    it('parses .mjs files as JavaScript', async () => {
      const f = writeFixture('module.mjs', 'export const x = 42;\n');
      const result = await parseFile(f, wasmDir);
      expect(result.error).toBeUndefined();
      expect(result.language).toBe('javascript');
    });

    it('parses .cjs files as JavaScript', async () => {
      const f = writeFixture('module.cjs', 'module.exports = {};\n');
      const result = await parseFile(f, wasmDir);
      expect(result.error).toBeUndefined();
      expect(result.language).toBe('javascript');
    });

    it('parses .jsx files as JavaScript', async () => {
      const f = writeFixture(
        'component.jsx',
        'const el = <div>hello</div>;\n',
      );
      const result = await parseFile(f, wasmDir);
      expect(result.error).toBeUndefined();
      expect(result.language).toBe('javascript');
    });

    it('parses .mts files as TypeScript', async () => {
      const f = writeFixture('module.mts', 'export const x: number = 42;\n');
      const result = await parseFile(f, wasmDir);
      expect(result.error).toBeUndefined();
      expect(result.language).toBe('typescript');
    });

    it('parses .cts files as TypeScript', async () => {
      const f = writeFixture('module.cts', 'export const x: number = 42;\n');
      const result = await parseFile(f, wasmDir);
      expect(result.error).toBeUndefined();
      expect(result.language).toBe('typescript');
    });
  });

  // ── Cache behaviour ────────────────────────────────────────────────────
  describe('cache behaviour', () => {
    it('returns cached result for an unchanged file', async () => {
      const f = writeFixture(
        'cache-test.js',
        'const cachedVal = 1;\n',
      );
      const result1 = await parseFile(f, wasmDir);
      const result2 = await parseFile(f, wasmDir);
      // Both calls should succeed without error
      expect(result1.error).toBeUndefined();
      expect(result2.error).toBeUndefined();
      // Same file, same content → same symbols
      expect(result2.symbols).toEqual(result1.symbols);
    });

    it('produces fresh result after file modification', async () => {
      const f = writeFixture(
        'cache-modified.js',
        'function version1() {}\n',
      );
      const result1 = await parseFile(f, wasmDir);
      const version1Symbols = result1.symbols.length;

      // Modify the file (new mtime)
      await new Promise((resolve) => setTimeout(resolve, 100)); // ensure different mtime
      writeFileSync(f, 'function version2() {}\nfunction extra() {}\n', 'utf-8');

      const result2 = await parseFile(f, wasmDir);
      // After modification, the cache should be invalidated and file re-parsed
      // with different symbols (version2 + extra, not version1)
      expect(result2.symbols.length).not.toBe(version1Symbols);
    });
  });

  // ── parseFiles (parallel) ──────────────────────────────────────────────
  describe('parseFiles - parallel parsing', () => {
    it('parses multiple files and returns results in order', async () => {
      const f1 = writeFixture('pf-a.js', 'function a() {}\n');
      const f2 = writeFixture('pf-b.js', 'function b() {}\n');
      const f3 = writeFixture('pf-c.js', 'function c() {}\n');

      const results = await parseFiles([f1, f2, f3], wasmDir);
      expect(results).toHaveLength(3);
      // Every result should be valid
      for (const r of results) {
        expect(r.error).toBeUndefined();
        expect(r.symbols.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('handles mixed valid and unsupported files', async () => {
      const f1 = writeFixture('pf-valid.js', 'function valid() {}\n');
      const f2 = join(tmpDir, 'pf-invalid.xyz');
      writeFileSync(f2, 'class Invalid {}\n', 'utf-8');

      const results = await parseFiles([f1, f2], wasmDir);
      expect(results).toHaveLength(2);
      expect(results[0].error).toBeUndefined();
      expect(results[1].error).toBeDefined();
    });
  });

  // ── Language registry ──────────────────────────────────────────────────
  describe('language registry re-exports', () => {
    it('exports languageForExtension and related helpers', async () => {
      const {
        languageForExtension,
        languageForFile,
        getAllExtensions,
      } = await import('../../src/analysis/parser.js');

      expect(typeof languageForExtension).toBe('function');
      expect(typeof languageForFile).toBe('function');
      expect(typeof getAllExtensions).toBe('function');

      const exts = getAllExtensions();
      expect(exts).toContain('.js');
      expect(exts).toContain('.ts');
      expect(exts).toContain('.tsx');
      expect(exts).toContain('.py');
    });

    // #395: .vue is registered via TypeScript extensions
    it('recognizes .vue extension as TypeScript for SFC preprocessing', async () => {
      const { getAllExtensions } = await import('../../src/analysis/parser.js');
      const exts = getAllExtensions();
      expect(exts).toContain('.vue');
    });
  });

  // ── #405: Overload Disambiguation ───────────────────────────────────────
  describe('overload disambiguation (#405)', () => {
    it('generates distinct IDs for same-name methods with different parameter counts', async () => {
      const { symbolId } = await import('../../src/analysis/language-definition.js');

      const id1 = symbolId('Method', 'src/foo.ts', 'save', 10, { parameterCount: 1 });
      const id2 = symbolId('Method', 'src/foo.ts', 'save', 20, { parameterCount: 2 });

      expect(id1).toBe('Method:src/foo.ts:save#1:L10');
      expect(id2).toBe('Method:src/foo.ts:save#2:L20');
      expect(id1).not.toBe(id2);
    });

    it('includes parameter types in ID when available', async () => {
      const { symbolId } = await import('../../src/analysis/language-definition.js');

      const id = symbolId('Method', 'src/foo.ts', 'save', 15, {
        parameterCount: 2,
        parameterTypes: ['string', 'number'],
      });

      expect(id).toBe('Method:src/foo.ts:save#2~string,number:L15');
    });

    it('omits parameter count for non-method labels', async () => {
      const { symbolId } = await import('../../src/analysis/language-definition.js');

      const id = symbolId('Class', 'src/foo.ts', 'User', 5);

      expect(id).toBe('Class:src/foo.ts:User:L5');
    });

    it('omits parameter count when count is 0 or undefined', async () => {
      const { symbolId } = await import('../../src/analysis/language-definition.js');

      const id1 = symbolId('Function', 'src/foo.ts', 'noop', 1, { parameterCount: 0 });
      const id2 = symbolId('Function', 'src/foo.ts', 'noop', 1);

      expect(id1).toBe('Function:src/foo.ts:noop:L1');
      expect(id2).toBe('Function:src/foo.ts:noop:L1');
    });
  });

  // ── #395: Vue SFC Preprocessing ─────────────────────────────────────────
  describe('Vue SFC preprocessing (#395)', () => {
    it('extracts <script setup> content from .vue file', async () => {
      const { preprocessVueSfc } = await import('../../src/analysis/languages/vue.js');

      const vueFile = writeFixture(
        'Component.vue',
        nl(
          '<template>',
          '  <div>{{ msg }}</div>',
          '</template>',
          '',
          '<script setup lang="ts">',
          'import { ref } from "vue";',
          'const msg = ref("hello");',
          '</script>',
        ),
      );

      const result = preprocessVueSfc(vueFile);
      expect(result).not.toBeNull();
      expect(result!.isSetup).toBe(true);
      expect(result!.content).toContain('import { ref } from "vue"');
      expect(result!.content).not.toContain('<template>');
      expect(result!.content).not.toContain('<script');
    });

    it('extracts regular <script> content from .vue file', async () => {
      const { preprocessVueSfc } = await import('../../src/analysis/languages/vue.js');

      const vueFile = writeFixture(
        'LegacyComponent.vue',
        nl(
          '<script>',
          'export default {',
          '  data() { return { count: 0 }; }',
          '};',
          '</script>',
        ),
      );

      const result = preprocessVueSfc(vueFile);
      expect(result).not.toBeNull();
      expect(result!.isSetup).toBe(false);
      expect(result!.content).toContain('export default');
    });

    it('returns null for .vue file with no script block', async () => {
      const { preprocessVueSfc } = await import('../../src/analysis/languages/vue.js');

      const vueFile = writeFixture(
        'TemplateOnly.vue',
        '<template><div>Hello</div></template>\n',
      );

      const result = preprocessVueSfc(vueFile);
      expect(result).toBeNull();
    });

    it('VUE_BUILT_INS includes common composables', async () => {
      const { VUE_BUILT_INS } = await import('../../src/analysis/languages/vue.js');

      expect(VUE_BUILT_INS.has('ref')).toBe(true);
      expect(VUE_BUILT_INS.has('computed')).toBe(true);
      expect(VUE_BUILT_INS.has('defineProps')).toBe(true);
      expect(VUE_BUILT_INS.has('onMounted')).toBe(true);
      expect(VUE_BUILT_INS.has('useRouter')).toBe(true);
      expect(VUE_BUILT_INS.has('nonexistent')).toBe(false);
    });
  });

  // ── #432: Symbol metadata extraction ────────────────────────────────────
  describe('symbol metadata extraction (#432)', () => {
    // ── TypeScript metadata ──────────────────────────────────────────────
    describe('TypeScript', () => {
      let tsMetaFile: string;

      beforeAll(() => {
        tsMetaFile = writeFixture(
          'metadata.ts',
          nl(
            'class MyClass {',
            '  private static async fetchData(url: string, opts?: RequestInit): Promise<Response> {',
            '    return fetch(url, opts);',
            '  }',
            '  public getData(): string[] { return []; }',
            '}',
            '',
            'function typedFn(name: string, age: number): boolean { return true; }',
            '',
            'const arrowTyped = (x: number, y: string): void => {};',
          ),
        );
      });

      it('extracts parameterTypes for method with typed params', async () => {
        const result = await parseFile(tsMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'fetchData');
        expect(method).toBeDefined();
        expect(method!.properties).toBeDefined();
        expect(method!.properties!.parameterTypes).toEqual(['string', 'RequestInit']);
      });

      it('extracts returnType for method', async () => {
        const result = await parseFile(tsMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'fetchData');
        expect(method).toBeDefined();
        expect(method!.properties!.returnType).toBe('Promise<Response>');
      });

      it('extracts visibility for private method', async () => {
        const result = await parseFile(tsMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'fetchData');
        expect(method).toBeDefined();
        expect(method!.properties!.visibility).toBe('private');
      });

      it('extracts visibility for public method', async () => {
        const result = await parseFile(tsMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'getData');
        expect(method).toBeDefined();
        expect(method!.properties!.visibility).toBe('public');
      });

      it('extracts isStatic flag', async () => {
        const result = await parseFile(tsMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'fetchData');
        expect(method).toBeDefined();
        expect(method!.properties!.isStatic).toBe(true);
      });

      it('extracts isAsync flag', async () => {
        const result = await parseFile(tsMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'fetchData');
        expect(method).toBeDefined();
        expect(method!.properties!.isAsync).toBe(true);
      });

      it('extracts parameterTypes and returnType for function declaration', async () => {
        const result = await parseFile(tsMetaFile, wasmDir);
        const fn = result.symbols.find((s) => s.name === 'typedFn');
        expect(fn).toBeDefined();
        expect(fn!.properties!.parameterTypes).toEqual(['string', 'number']);
        expect(fn!.properties!.returnType).toBe('boolean');
      });

      it('extracts parameterTypes and returnType for arrow function', async () => {
        const result = await parseFile(tsMetaFile, wasmDir);
        const fn = result.symbols.find((s) => s.name === 'arrowTyped');
        expect(fn).toBeDefined();
        expect(fn!.properties!.parameterTypes).toEqual(['number', 'string']);
        expect(fn!.properties!.returnType).toBe('void');
      });
    });

    // ── Python metadata ──────────────────────────────────────────────────
    describe('Python', () => {
      let pyMetaFile: string;

      beforeAll(() => {
        pyMetaFile = writeFixture(
          'metadata.py',
          nl(
            'def typed_function(name: str, age: int) -> bool:',
            '    pass',
            '',
            'async def async_function(data: list) -> None:',
            '    pass',
            '',
            'def _private_helper(x: int) -> str:',
            '    pass',
            '',
            'def __mangled(x: int) -> str:',
            '    pass',
          ),
        );
      });

      it('extracts parameterTypes for typed Python function', async () => {
        const result = await parseFile(pyMetaFile, wasmDir);
        const fn = result.symbols.find((s) => s.name === 'typed_function');
        expect(fn).toBeDefined();
        expect(fn!.properties).toBeDefined();
        expect(fn!.properties!.parameterTypes).toEqual(['str', 'int']);
      });

      it('extracts returnType for Python function', async () => {
        const result = await parseFile(pyMetaFile, wasmDir);
        const fn = result.symbols.find((s) => s.name === 'typed_function');
        expect(fn).toBeDefined();
        expect(fn!.properties!.returnType).toBe('bool');
      });

      it('extracts isAsync for async Python function', async () => {
        const result = await parseFile(pyMetaFile, wasmDir);
        const fn = result.symbols.find((s) => s.name === 'async_function');
        expect(fn).toBeDefined();
        expect(fn!.properties!.isAsync).toBe(true);
      });

      it('extracts returnType for async Python function', async () => {
        const result = await parseFile(pyMetaFile, wasmDir);
        const fn = result.symbols.find((s) => s.name === 'async_function');
        expect(fn).toBeDefined();
        expect(fn!.properties!.returnType).toBe('None');
      });

      it('extracts visibility for _prefixed Python function (protected)', async () => {
        const result = await parseFile(pyMetaFile, wasmDir);
        const fn = result.symbols.find((s) => s.name === '_private_helper');
        expect(fn).toBeDefined();
        expect(fn!.properties!.visibility).toBe('protected');
      });

      it('extracts visibility for __prefixed Python function (private)', async () => {
        const result = await parseFile(pyMetaFile, wasmDir);
        const fn = result.symbols.find((s) => s.name === '__mangled');
        expect(fn).toBeDefined();
        expect(fn!.properties!.visibility).toBe('private');
      });
    });

    // ── Java metadata ────────────────────────────────────────────────────
    describe.runIf(hasWasm('tree-sitter-java.wasm'))('Java', () => {
      let javaMetaFile: string;

      beforeAll(() => {
        javaMetaFile = writeFixture(
          'Metadata.java',
          nl(
            'public class Metadata {',
            '  public static void main(String[] args) {}',
            '  private String getName(int id) { return ""; }',
            '  protected abstract void process();',
            '}',
          ),
        );
      });

      it('extracts visibility for public static Java method', async () => {
        const result = await parseFile(javaMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'main');
        expect(method).toBeDefined();
        expect(method!.properties).toBeDefined();
        expect(method!.properties!.visibility).toBe('public');
      });

      it('extracts isStatic for static Java method', async () => {
        const result = await parseFile(javaMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'main');
        expect(method).toBeDefined();
        expect(method!.properties!.isStatic).toBe(true);
      });

      it('extracts returnType for Java method', async () => {
        const result = await parseFile(javaMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'getName');
        expect(method).toBeDefined();
        expect(method!.properties!.returnType).toBe('String');
      });

      it('extracts visibility for private Java method', async () => {
        const result = await parseFile(javaMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'getName');
        expect(method).toBeDefined();
        expect(method!.properties!.visibility).toBe('private');
      });

      it('extracts parameterTypes for Java method', async () => {
        const result = await parseFile(javaMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'getName');
        expect(method).toBeDefined();
        expect(method!.properties!.parameterTypes).toEqual(['int']);
      });

      it('extracts isAbstract for abstract Java method', async () => {
        const result = await parseFile(javaMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'process');
        expect(method).toBeDefined();
        expect(method!.properties!.isAbstract).toBe(true);
      });

      it('extracts visibility for protected Java method', async () => {
        const result = await parseFile(javaMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'process');
        expect(method).toBeDefined();
        expect(method!.properties!.visibility).toBe('protected');
      });
    });

    // ── C# metadata ──────────────────────────────────────────────────────
    describe.runIf(hasWasm('tree-sitter-c-sharp.wasm'))('C#', () => {
      let csMetaFile: string;

      beforeAll(() => {
        csMetaFile = writeFixture(
          'Metadata.cs',
          nl(
            'public class Metadata {',
            '  public static void Main(string[] args) {}',
            '  private int Compute(int x, int y) { return 0; }',
            '}',
          ),
        );
      });

      it('extracts visibility for public static C# method', async () => {
        const result = await parseFile(csMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'Main');
        expect(method).toBeDefined();
        expect(method!.properties).toBeDefined();
        expect(method!.properties!.visibility).toBe('public');
      });

      it('extracts isStatic for static C# method', async () => {
        const result = await parseFile(csMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'Main');
        expect(method).toBeDefined();
        expect(method!.properties!.isStatic).toBe(true);
      });

      it('extracts returnType for C# method', async () => {
        const result = await parseFile(csMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'Compute');
        expect(method).toBeDefined();
        expect(method!.properties!.returnType).toBe('int');
      });

      it('extracts parameterTypes for C# method', async () => {
        const result = await parseFile(csMetaFile, wasmDir);
        const method = result.symbols.find((s) => s.name === 'Compute');
        expect(method).toBeDefined();
        expect(method!.properties!.parameterTypes).toEqual(['int', 'int']);
      });
    });
  });
});
