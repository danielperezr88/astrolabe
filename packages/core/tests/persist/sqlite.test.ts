/**
 * Tests for the SQLite persistence layer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteStore } from '../../src/persist/sqlite.js';
import type { SqliteStore } from '../../src/persist/sqlite.js';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../../src/core/types.js';

let testDir: string;
let dbPath: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'astrolabe-persist-'));
  dbPath = join(testDir, 'test.db');
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return { label: 'Function', properties: {}, ...overrides };
}

function makeRel(overrides: Partial<GraphRelationship> & { id: string; sourceId: string; targetId: string }): GraphRelationship {
  return { type: 'CALLS', confidence: 1.0, reason: 'test', ...overrides };
}

function buildTestGraph(): KnowledgeGraph {
  const g = createKnowledgeGraph();
  g.addNode(makeNode({ id: 'fn:src/a.ts:foo', label: 'Function', properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, isExported: true } }));
  g.addNode(makeNode({ id: 'fn:src/b.ts:bar', label: 'Function', properties: { name: 'bar', filePath: 'src/b.ts', startLine: 10, isExported: false } }));
  g.addNode(makeNode({ id: 'class:src/b.ts:Baz', label: 'Class', properties: { name: 'Baz', filePath: 'src/b.ts', startLine: 5, isExported: true } }));
  g.addRelationship(makeRel({ id: 'rel:1', sourceId: 'fn:src/a.ts:foo', targetId: 'fn:src/b.ts:bar', type: 'CALLS' }));
  g.addRelationship(makeRel({ id: 'rel:2', sourceId: 'class:src/b.ts:Baz', targetId: 'fn:src/b.ts:bar', type: 'CONTAINS', confidence: 1.0, reason: 'method' }));
  g.addRelationship(makeRel({ id: 'rel:3', sourceId: 'fn:src/a.ts:foo', targetId: 'class:src/b.ts:Baz', type: 'CALLS', confidence: 0.8, reason: 'test', evidence: [{ kind: 'scope', weight: 0.8 }] }));
  return g;
}

describe('SqliteStore', () => {
  describe('saveGraph / loadGraph', () => {
    it('round-trips a graph with nodes and relationships', () => {
      const store = createSqliteStore(dbPath);
      const original = buildTestGraph();

      store.saveGraph(original);
      const loaded = store.loadGraph();

      expect(loaded.nodeCount).toBe(original.nodeCount);
      expect(loaded.relationshipCount).toBe(original.relationshipCount);

      // Verify node fidelity
      for (const node of original.nodes) {
        const loadedNode = loaded.getNode(node.id);
        expect(loadedNode).toBeDefined();
        expect(loadedNode?.label).toBe(node.label);
        expect(loadedNode?.properties).toEqual(node.properties);
      }

      // Verify relationship fidelity
      for (const rel of original.relationships) {
        const loadedRel = loaded.getRelationship(rel.id);
        expect(loadedRel).toBeDefined();
        expect(loadedRel?.sourceId).toBe(rel.sourceId);
        expect(loadedRel?.targetId).toBe(rel.targetId);
        expect(loadedRel?.type).toBe(rel.type);
        expect(loadedRel?.confidence).toBe(rel.confidence);
        expect(loadedRel?.reason).toBe(rel.reason);
      }

      store.close();
    });

    it('handles empty graph', () => {
      const emptyPath = join(testDir, 'empty.db');
      const store = createSqliteStore(emptyPath);
      const empty = createKnowledgeGraph();

      store.saveGraph(empty);
      const loaded = store.loadGraph();

      expect(loaded.nodeCount).toBe(0);
      expect(loaded.relationshipCount).toBe(0);

      store.close();
    });

    it('updates existing data on second save', () => {
      const store = createSqliteStore(dbPath);
      const g1 = createKnowledgeGraph();
      g1.addNode(makeNode({ id: 'fn:x:hello', label: 'Function', properties: { name: 'hello' } }));
      g1.addRelationship(makeRel({ id: 'rel:a', sourceId: 'fn:x:hello', targetId: 'fn:x:hello', type: 'CALLS' }));

      store.saveGraph(g1);
      expect(store.getNodeCount()).toBe(1);

      // Overwrite with different graph
      const g2 = createKnowledgeGraph();
      g2.addNode(makeNode({ id: 'fn:y:world', label: 'Class', properties: { name: 'world' } }));
      store.saveGraph(g2);

      expect(store.getNodeCount()).toBe(1);
      const loaded = store.loadGraph();
      expect(loaded.getNode('fn:x:hello')).toBeUndefined();
      expect(loaded.getNode('fn:y:world')).toBeDefined();

      store.close();
    });
  });

  describe('file_hashes', () => {
    it('saves and retrieves file hashes', () => {
      const store = createSqliteStore(dbPath);

      store.saveFileHash('src/a.ts', 'abc123');
      expect(store.getFileHash('src/a.ts')).toBe('abc123');
      expect(store.getFileHash('nonexistent.ts')).toBeUndefined();

      store.close();
    });

    it('updates existing file hash', () => {
      const store = createSqliteStore(dbPath);

      store.saveFileHash('src/a.ts', 'hash1');
      store.saveFileHash('src/a.ts', 'hash2');
      expect(store.getFileHash('src/a.ts')).toBe('hash2');

      store.close();
    });
  });

  describe('getChangedFiles', () => {
    it('returns only changed or new files', () => {
      const store = createSqliteStore(dbPath);

      store.saveFileHash('src/a.ts', 'hash1');
      store.saveFileHash('src/b.ts', 'hash2');
      store.saveFileHash('src/c.ts', 'hash3');

      const changed = store.getChangedFiles([
        { path: 'src/a.ts', hash: 'hash1' },        // unchanged
        { path: 'src/b.ts', hash: 'hash2-modified' }, // modified
        { path: 'src/d.ts', hash: 'newhash' },        // new
      ]);

      expect(changed).toHaveLength(2);
      expect(changed.map((f) => f.path)).toEqual(['src/b.ts', 'src/d.ts']);

      store.close();
    });

    it('returns all files when no hashes are stored', () => {
      const freshPath = join(testDir, 'fresh.db');
      const store = createSqliteStore(freshPath);

      const files = [
        { path: 'src/a.ts', hash: 'hash1' },
        { path: 'src/b.ts', hash: 'hash2' },
      ];
      const changed = store.getChangedFiles(files);

      expect(changed).toEqual(files);

      store.close();
    });
  });

  describe('counts', () => {
    it('getNodeCount and getRelationshipCount work', () => {
      const store = createSqliteStore(dbPath);
      const g = buildTestGraph();

      store.saveGraph(g);
      expect(store.getNodeCount()).toBe(3);
      expect(store.getRelationshipCount()).toBe(3);

      store.close();
    });
  });
});
