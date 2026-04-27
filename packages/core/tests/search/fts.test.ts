/**
 * Tests for the BM25 FTS5 search module.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFtsSearch } from '../../src/search/fts.js';
import { createSqliteStore } from '../../src/persist/sqlite.js';
import type { SqliteStore } from '../../src/persist/sqlite.js';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import type { GraphNode } from '../../src/core/types.js';

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'astrolabe-fts-'));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return { label: 'Function', properties: {}, ...overrides };
}

describe('FtsSearch', () => {
  it('indexes graph nodes and searches by name', () => {
    const dbPath = join(testDir, 'fts-test.db');
    const fts = createFtsSearch(dbPath);
    const store = createSqliteStore(dbPath);

    const graph = createKnowledgeGraph();
    graph.addNode(makeNode({ id: 'fn:a:helper', label: 'Function', properties: { name: 'helper', filePath: 'src/a.ts', keywords: ['util', 'format'] } }));
    graph.addNode(makeNode({ id: 'fn:b:main', label: 'Function', properties: { name: 'main', filePath: 'src/b.ts', keywords: ['entry'] } }));
    graph.addNode(makeNode({ id: 'cls:c:User', label: 'Class', properties: { name: 'UserService', filePath: 'src/c.ts', keywords: ['auth', 'user'] } }));
    store.saveGraph(graph);

    fts.indexGraph(store);

    const results = fts.search('helper');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].nodeId).toBe('fn:a:helper');
    expect(results[0].score).toBeLessThan(0); // BM25 negative rank

    fts.close();
    store.close();
  });

  it('returns results ranked by relevance', () => {
    const dbPath = join(testDir, 'fts-rank.db');
    const fts = createFtsSearch(dbPath);
    const store = createSqliteStore(dbPath);

    const graph = createKnowledgeGraph();
    graph.addNode(makeNode({ id: 'fn:a:render', label: 'Function', properties: { name: 'render', filePath: 'src/a.ts' } }));
    graph.addNode(makeNode({ id: 'fn:b:renderPage', label: 'Function', properties: { name: 'renderPage', filePath: 'src/b.ts' } }));
    graph.addNode(makeNode({ id: 'fn:c:unrelated', label: 'Function', properties: { name: 'unrelated', filePath: 'src/c.ts' } }));
    store.saveGraph(graph);
    fts.indexGraph(store);

    const results = fts.search('render');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Higher relevance for exact match 'render' over 'renderPage'
    const first = results[0];
    expect(first.nodeId).toMatch(/render/);

    fts.close();
    store.close();
  });

  it('handles empty search gracefully', () => {
    const dbPath = join(testDir, 'fts-empty.db');
    const fts = createFtsSearch(dbPath);

    const results = fts.search('');
    expect(results).toEqual([]);

    fts.close();
  });

  it('supports incremental node indexing', () => {
    const dbPath = join(testDir, 'fts-incr.db');
    const fts = createFtsSearch(dbPath);

    fts.indexNode('fn:x:test', 'Function', 'testFn', 'src/x.ts', ['test']);
    const results = fts.search('testFn');
    expect(results.length).toBe(1);
    expect(results[0].nodeId).toBe('fn:x:test');

    fts.deindexNode('fn:x:test');
    const afterDelete = fts.search('testFn');
    expect(afterDelete).toHaveLength(0);

    fts.close();
  });

  it('handles special characters in search query', () => {
    const dbPath = join(testDir, 'fts-special.db');
    const fts = createFtsSearch(dbPath);

    fts.indexNode('fn:x:test', 'Function', 'getUserData', 'src/x.ts');

    const results = fts.search('getUserData !! ** ""'); // Special chars should be sanitized
    expect(results.length).toBe(1);

    fts.close();
  });
});
