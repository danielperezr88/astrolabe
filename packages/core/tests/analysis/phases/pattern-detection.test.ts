/**
 * Tests for the Pattern Detection pipeline phase (#872 Phase 2).
 *
 * Validates that the phase correctly runs tree-sitter pattern queries,
 * creates PatternInstance nodes, and links them with IMPLEMENTS_PATTERN edges.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AST_TREE_CACHE_KEY } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';
import { AstCache } from '../../../src/analysis/ast-cache.js';

// ── Mock query result registry (hoisted for vi.mock factory access) ─────────

const { queryResults } = vi.hoisted(() => {
  const queryResults = new Map<string, unknown[]>();
  return { queryResults };
});

// Mock web-tree-sitter at the bare specifier level.
// The phase imports type-only from web-tree-sitter, but parser.ts (transitive)
// imports values. Mocking here prevents WASM init.
vi.mock('web-tree-sitter', () => {
  const qr: Map<string, unknown[]> = queryResults;
  return {
    Query: class MockQuery {
      private result: unknown[];
      constructor(_lang: unknown, pattern: string) {
        this.result = qr.get(pattern) ?? [];
      }
      matches(_node: unknown): unknown[] { return this.result; }
      delete(): void { /* no-op */ }
    },
    Language: class MockLanguage {},
    Parser: class MockParser {
      static init() { return Promise.resolve(); }
    },
  };
});

vi.mock('../../../src/analysis/languages/index.js', () => ({
  languageForFile: vi.fn(),
}));

vi.mock('../../../src/analysis/parser.js', () => ({
  defaultWasmDir: vi.fn(() => '/dummy/wasm'),
}));

import { languageForFile } from '../../../src/analysis/languages/index.js';
import { patternDetectionPhase } from '../../../src/analysis/phases/pattern-detection.js';
import type { PatternDetectionOutput } from '../../../src/analysis/phases/pattern-detection.js';

const mockedLanguageForFile = vi.mocked(languageForFile);

// ── Test helpers ────────────────────────────────────────────────────────────

/** Create a mock tree-sitter capture. */
function mockCapture(name: string, text: string, startRow: number, endRow: number) {
  return {
    name,
    node: {
      text,
      startPosition: { row: startRow },
      endPosition: { row: endRow },
    },
  };
}

/** Create a mock tree-sitter query match. */
function mockMatch(captures: Array<ReturnType<typeof mockCapture>>) {
  return { captures, patternIndex: 0 };
}

/** Create a mock tree object. */
function mockTree() {
  return { rootNode: { id: 'mock-root' } };
}

/** Create a mock LanguageDefinition for TypeScript. */
function mockTsLangDef() {
  return {
    name: 'typescript' as const,
    wasmFile: 'typescript.wasm',
    extensions: ['.ts'],
    importSemantics: 'named' as const,
    mroStrategy: 'c3' as const,
    symbolPatterns: [],
    importPatterns: [],
    load: vi.fn(() => Promise.resolve({
      query: (pattern: string) => {
        const qr = queryResults.get(pattern) ?? [];
        return {
          matches: () => qr,
          delete: () => {},
        };
      },
    })),
  };
}

/** Create a PhaseContext suitable for testing. */
function createTestContext(repoPath = '/test/repo') {
  const graph = createKnowledgeGraph();
  const state = new Map<string, unknown>();
  return {
    repoPath,
    graph,
    state,
    onProgress: vi.fn(),
    pipelineStart: Date.now(),
    incremental: undefined,
  };
}

/** Inject an AstCache into context.state with given entries. */
function injectAstCache(
  context: ReturnType<typeof createTestContext>,
  entries: Array<{ filePath: string; tree: unknown }>,
) {
  const cache = new AstCache(entries.length + 10);
  for (const entry of entries) {
    cache.set(entry.filePath, entry.tree);
  }
  context.state.set(AST_TREE_CACHE_KEY, cache);
  return cache;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Pattern Detection Phase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.clear();
  });

  it('produces correct output shape with empty cache', async () => {
    const context = createTestContext();
    injectAstCache(context, []);

    const result = await patternDetectionPhase.execute(context) as PatternDetectionOutput;

    expect(result).toEqual({
      matchCount: 0,
      patternsByCategory: {},
      filesWithPatterns: 0,
    });
  });

  it('produces correct output with no AST cache', async () => {
    const context = createTestContext();

    const result = await patternDetectionPhase.execute(context) as PatternDetectionOutput;

    expect(result).toEqual({
      matchCount: 0,
      patternsByCategory: {},
      filesWithPatterns: 0,
    });
  });

  it('creates PatternInstance nodes for matches', async () => {
    const context = createTestContext('/repo');
    const absPath = '/repo/src/singleton.ts';
    const tree = mockTree();

    injectAstCache(context, [{ filePath: absPath, tree }]);

    const singletonMatch = mockMatch([
      mockCapture('pattern_name', 'MySingleton', 0, 20),
      mockCapture('method_name', 'getInstance', 5, 10),
      mockCapture('return_type', 'MySingleton', 5, 10),
      mockCapture('access_mod', 'private', 1, 2),
      mockCapture('field_name', 'instance', 2, 3),
      mockCapture('field_type', 'MySingleton', 2, 3),
    ]);

    const firstTsSingletonQuery = `(class_declaration name: (type_identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method_name return_type: (type_identifier) @return_type) (public_field_definition (accessibility_modifier) @access_mod name: (property_identifier) @field_name type: (type_identifier) @field_type)))`;
    queryResults.set(firstTsSingletonQuery, [singletonMatch]);

    mockedLanguageForFile.mockReturnValue(mockTsLangDef() as unknown as ReturnType<typeof languageForFile>);

    const result = await patternDetectionPhase.execute(context) as PatternDetectionOutput;

    expect(result.matchCount).toBeGreaterThanOrEqual(1);
    expect(result.filesWithPatterns).toBe(1);

    const patternNodes = context.graph.findNodesByLabel('PatternInstance');
    expect(patternNodes.length).toBeGreaterThanOrEqual(1);

    const node = patternNodes[0];
    expect(node.properties.patternId).toBe('gof-singleton');
    expect(node.properties.category).toBe('gof-creational');
    expect(node.properties.filePath).toBe('src/singleton.ts');
    expect(node.properties.confidence).toBeGreaterThan(0);
  });

  it('creates IMPLEMENTS_PATTERN edges', async () => {
    const context = createTestContext('/repo');
    const absPath = '/repo/src/singleton.ts';
    const tree = mockTree();

    injectAstCache(context, [{ filePath: absPath, tree }]);

    const singletonMatch = mockMatch([
      mockCapture('pattern_name', 'MySingleton', 0, 20),
      mockCapture('method_name', 'getInstance', 5, 10),
      mockCapture('return_type', 'MySingleton', 5, 10),
      mockCapture('access_mod', 'private', 1, 2),
      mockCapture('field_name', 'instance', 2, 3),
      mockCapture('field_type', 'MySingleton', 2, 3),
    ]);

    const firstTsSingletonQuery = `(class_declaration name: (type_identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method_name return_type: (type_identifier) @return_type) (public_field_definition (accessibility_modifier) @access_mod name: (property_identifier) @field_name type: (type_identifier) @field_type)))`;
    queryResults.set(firstTsSingletonQuery, [singletonMatch]);

    mockedLanguageForFile.mockReturnValue(mockTsLangDef() as unknown as ReturnType<typeof languageForFile>);

    await patternDetectionPhase.execute(context) as PatternDetectionOutput;

    const edges = Array.from(context.graph.iterRelationships())
      .filter((r) => r.type === 'IMPLEMENTS_PATTERN');
    expect(edges.length).toBeGreaterThanOrEqual(1);

    const edge = edges[0];
    expect(edge.sourceId).toBe('file:src/singleton.ts');
    expect(edge.targetId).toContain('pattern:src/singleton.ts:gof-singleton:');
    expect(edge.reason).toBe('pattern-detection');
    expect(edge.confidence).toBeGreaterThan(0);
  });

  it('skips files with no pattern definitions for language', async () => {
    const context = createTestContext('/repo');
    const absPath = '/repo/src/data.proto';
    const tree = mockTree();

    injectAstCache(context, [{ filePath: absPath, tree }]);

    const protobufLangDef = {
      name: 'protobuf',
      wasmFile: 'protobuf.wasm',
      extensions: ['.proto'],
      importSemantics: 'named' as const,
      mroStrategy: 'none' as const,
      symbolPatterns: [],
      importPatterns: [],
      load: vi.fn(() => Promise.resolve({})),
    };
    mockedLanguageForFile.mockReturnValue(protobufLangDef as unknown as ReturnType<typeof languageForFile>);

    const result = await patternDetectionPhase.execute(context) as PatternDetectionOutput;

    expect(result.matchCount).toBe(0);
    expect(result.filesWithPatterns).toBe(0);
  });

  it('applies postFilters to reject invalid matches', async () => {
    const context = createTestContext('/repo');
    const absPath = '/repo/src/fake.ts';
    const tree = mockTree();

    injectAstCache(context, [{ filePath: absPath, tree }]);

    const badMatch = mockMatch([
      mockCapture('pattern_name', 'NotASingleton', 0, 10),
      mockCapture('method_name', 'someOtherMethod', 2, 5),
      mockCapture('return_type', 'SomeType', 3, 5),
      mockCapture('access_mod', 'private', 1, 2),
      mockCapture('field_name', 'instance', 2, 3),
      mockCapture('field_type', 'SomeType', 2, 3),
    ]);

    const firstTsSingletonQuery = `(class_declaration name: (type_identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method_name return_type: (type_identifier) @return_type) (public_field_definition (accessibility_modifier) @access_mod name: (property_identifier) @field_name type: (type_identifier) @field_type)))`;
    queryResults.set(firstTsSingletonQuery, [badMatch]);

    mockedLanguageForFile.mockReturnValue(mockTsLangDef() as unknown as ReturnType<typeof languageForFile>);

    await patternDetectionPhase.execute(context) as PatternDetectionOutput;

    const singletonNodes = context.graph.findNodesByLabel('PatternInstance')
      .filter((n) => n.properties.patternId === 'gof-singleton' && n.properties.confidence === 0.85);
    expect(singletonNodes.length).toBe(0);
  });
});
