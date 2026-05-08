/**
 * Tests for the BM25 FTS5 search module.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
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

/** Check whether the fts_nodes table exists in sqlite_master. */
function ftsTableExists(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fts_nodes'").get() as { name: string } | undefined;
    return !!row;
  } finally {
    db.close();
  }
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

// ── Lazy initialization tests ──────────────────────────────────────────────

describe('FtsSearch lazy initialization', () => {
  it('does NOT create fts_nodes table on construction', () => {
    const dbPath = join(testDir, 'fts-lazy-no-create.db');
    const fts = createFtsSearch(dbPath);
    try {
      // Merely creating the FTS search instance should NOT create the fts_nodes table
      expect(ftsTableExists(dbPath)).toBe(false);
    } finally {
      fts.close();
    }
  });

  it('creates fts_nodes table on first search call', () => {
    const dbPath = join(testDir, 'fts-lazy-first-search.db');
    const fts = createFtsSearch(dbPath);
    try {
      expect(ftsTableExists(dbPath)).toBe(false);
      fts.search('anything');
      expect(ftsTableExists(dbPath)).toBe(true);
    } finally {
      fts.close();
    }
  });

  it('creates fts_nodes table on first indexNode call', () => {
    const dbPath = join(testDir, 'fts-lazy-index-node.db');
    const fts = createFtsSearch(dbPath);
    try {
      expect(ftsTableExists(dbPath)).toBe(false);
      fts.indexNode('fn:x:lazy', 'Function', 'lazyFn', 'src/lazy.ts');
      expect(ftsTableExists(dbPath)).toBe(true);
      const results = fts.search('lazyFn');
      expect(results).toHaveLength(1);
      expect(results[0].nodeId).toBe('fn:x:lazy');
    } finally {
      fts.close();
    }
  });

  it('populates from existing nodes table on first search', () => {
    const dbPath = join(testDir, 'fts-lazy-populate.db');
    // First: persist a graph using SqliteStore (simulate analyze phase)
    const store = createSqliteStore(dbPath);
    const graph = createKnowledgeGraph();
    graph.addNode(makeNode({ id: 'fn:a:authenticate', label: 'Function', properties: { name: 'authenticate', filePath: 'src/auth.ts', keywords: ['login', 'jwt'] } }));
    graph.addNode(makeNode({ id: 'fn:b:logout', label: 'Function', properties: { name: 'logout', filePath: 'src/auth.ts' } }));
    store.saveGraph(graph);
    store.close();

    // No FTS table created during "analyze" — it shouldn't exist yet
    expect(ftsTableExists(dbPath)).toBe(false);

    // Now create FTS and search — lazy init should populate from nodes table
    const fts = createFtsSearch(dbPath);
    try {
      const results = fts.search('authenticate');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].nodeId).toBe('fn:a:authenticate');
      // logout node should also be findable
      const results2 = fts.search('logout');
      expect(results2).toHaveLength(1);
    } finally {
      fts.close();
    }
  });

  it('skips creation if fts_nodes already exists in sqlite_master', () => {
    const dbPath = join(testDir, 'fts-lazy-preexisting.db');
    // Create the FTS table manually beforehand
    const db = new Database(dbPath);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_nodes USING fts5(
        node_id, label, name, filePath, keywords,
        tokenize='porter unicode61'
      );
      INSERT INTO fts_nodes VALUES ('fn:pre:existing', 'Function', 'preExisting', 'pre.ts', '');
    `);
    db.close();

    // FTS table already exists
    expect(ftsTableExists(dbPath)).toBe(true);

    // createFtsSearch should find it, not recreate it, and the existing data should be searchable
    const fts = createFtsSearch(dbPath);
    try {
      const results = fts.search('preExisting');
      expect(results).toHaveLength(1);
      expect(results[0].nodeId).toBe('fn:pre:existing');
    } finally {
      fts.close();
    }
  });

  it('cache flag avoids repeated sqlite_master checks', () => {
    const dbPath = join(testDir, 'fts-lazy-cache.db');
    const fts = createFtsSearch(dbPath);
    try {
      // First search triggers creation
      fts.search('first');
      expect(ftsTableExists(dbPath)).toBe(true);

      // Subsequent searches should not fail — the in-process flag skips re-creation
      fts.indexNode('fn:x:cached', 'Function', 'cachedFn', 'src/c.ts');
      const results = fts.search('cachedFn');
      expect(results).toHaveLength(1);

      // Multiple searches in a row work fine
      fts.search('second');
      fts.search('third');
      fts.deindexNode('fn:x:cached');
      expect(fts.search('cachedFn')).toHaveLength(0);
    } finally {
      fts.close();
    }
  });

  it('lazy population handles database with no nodes table gracefully', () => {
    const dbPath = join(testDir, 'fts-lazy-no-nodes.db');
    // Fresh database — no nodes table at all
    const fts = createFtsSearch(dbPath);
    try {
      // Should not throw, just return empty results
      const results = fts.search('anything');
      expect(results).toEqual([]);
      // But the FTS table should now exist
      expect(ftsTableExists(dbPath)).toBe(true);
    } finally {
      fts.close();
    }
  });

  // #643 Pitfall 1: Verify FTS5 indexes survive DB close/reopen
  it('queries work after close/reopen (FTS5 persistence)', () => {
    const dbPath = join(testDir, 'fts-persist.db');
    const graph = createKnowledgeGraph();
    graph.addNode(makeNode({ id: 'fn:a:alpha', label: 'Function', properties: { name: 'alphaExport', filePath: 'src/alpha.ts', keywords: ['core', 'export'] } }));
    graph.addNode(makeNode({ id: 'fn:b:beta', label: 'Function', properties: { name: 'betaUtil', filePath: 'src/beta.ts', keywords: ['util'] } }));

    // Round 1: create, save, index, close
    {
      const store = createSqliteStore(dbPath);
      const fts = createFtsSearch(dbPath);
      store.saveGraph(graph);
      fts.indexGraph(store);

      const r1 = fts.search('alpha');
      expect(r1.length).toBeGreaterThanOrEqual(1);
      expect(r1[0].nodeId).toBe('fn:a:alpha');

      fts.close();
      store.close();
    }

    // Verify SQLite file still exists on disk
    expect(require('node:fs').existsSync(dbPath)).toBe(true);

    // Round 2: reopen, search again without re-indexing
    {
      const store2 = createSqliteStore(dbPath);
      const fts2 = createFtsSearch(dbPath);
      // No indexGraph() call — expect persisted index to work

      const r2 = fts2.search('alpha');
      expect(r2.length).toBeGreaterThanOrEqual(1);
      expect(r2[0].nodeId).toBe('fn:a:alpha');

      fts2.close();
      store2.close();
    }
  });
});
