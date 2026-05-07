/**
 * Tests for Hybrid Search (#261) — embedding store + vector similarity + RRF.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTfIdfIndex } from '../../src/search/embeddings.js';
import { createTfIdfEmbeddingProvider } from '../../src/search/embeddings-store.js';
import { cosineSimilarityVec, hybridSearch } from '../../src/search/hybrid-search.js';
import { createFtsSearch } from '../../src/search/fts.js';
import { createSqliteStore } from '../../src/persist/sqlite.js';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import { EmbeddingStore } from '../../src/search/embeddings-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

let testDir: string;
let dbPath: string;

describe('Hybrid Search (#261)', () => {
  describe('TF-IDF Embedding Provider', () => {
    it('builds vocabulary from index and encodes text', () => {
      const index = buildTfIdfIndex([
        { nodeId: 'fn:a', text: 'user authentication login handler' },
        { nodeId: 'fn:b', text: 'payment billing invoice processor' },
        { nodeId: 'fn:c', text: 'database search query index' },
      ]);
      const provider = createTfIdfEmbeddingProvider(index);
      expect(provider.dimensions).toBeGreaterThan(0);

      const vec = provider.encode('user authentication');
      expect(vec.length).toBe(provider.dimensions);
      // At least some dimensions should be non-zero (matching terms)
      expect(vec.some((v) => v > 0)).toBe(true);
    });

    it('produces zero vector for text with no matching vocabulary', () => {
      const index = buildTfIdfIndex([
        { nodeId: 'fn:a', text: 'hello world' },
      ]);
      const provider = createTfIdfEmbeddingProvider(index);
      const vec = provider.encode('zzzzzzzzz unknown');
      expect(vec.every((v) => v === 0)).toBe(true);
    });

    it('handles empty index gracefully', () => {
      const index = buildTfIdfIndex([]);
      const provider = createTfIdfEmbeddingProvider(index);
      expect(provider.dimensions).toBe(384); // fallback dimensionality
      const vec = provider.encode('test');
      expect(vec.length).toBe(384);
    });
  });

  describe('cosineSimilarityVec', () => {
    it('returns 1 for identical vectors', () => {
      const a = new Float32Array([0.5, 0.3, 0.2]);
      const sim = cosineSimilarityVec(a, a);
      expect(sim).toBeCloseTo(1.0, 5);
    });

    it('returns 0 for orthogonal vectors', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([0, 1, 0]);
      const sim = cosineSimilarityVec(a, b);
      expect(sim).toBeCloseTo(0, 5);
    });

    it('returns 0 for zero vectors', () => {
      const a = new Float32Array([0, 0, 0]);
      const b = new Float32Array([1, 0, 0]);
      const sim = cosineSimilarityVec(a, b);
      expect(sim).toBe(0);
    });

    it('computes intermediate similarity correctly', () => {
      const a = new Float32Array([1, 1, 0]);
      const b = new Float32Array([1, 0, 1]);
      const sim = cosineSimilarityVec(a, b);
      // dot=1, normA=√2, normB=√2, sim = 1/(√2*√2) = 0.5
      expect(sim).toBeCloseTo(0.5, 5);
    });
  });

  describe('EmbeddingStore', () => {
    beforeAll(() => {
      testDir = mkdtempSync(join(tmpdir(), 'astrolabe-emb-'));
      dbPath = join(testDir, 'emb-test.db');
    });

    afterAll(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it('creates embeddings table on construction', () => {
      const db = new Database(dbPath);
      new EmbeddingStore(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'").all();
      expect(tables.length).toBe(1);
      db.close();
    });

    it('upserts and retrieves embeddings', () => {
      const db = new Database(dbPath);
      const store = new EmbeddingStore(db);
      const vec = new Float32Array([0.1, 0.2, 0.3]);
      store.upsert('node:1', 'hash123', vec);

      const entry = store.get('node:1');
      expect(entry).not.toBeNull();
      expect(entry!.dimensions).toBe(3);
      expect(entry!.contentHash).toBe('hash123');
      db.close();
    });

    it('returns null for missing node', () => {
      const db = new Database(dbPath);
      const store = new EmbeddingStore(db);
      expect(store.get('nonexistent')).toBeNull();
      db.close();
    });

    it('getAll returns all stored embeddings', () => {
      const db = new Database(dbPath);
      const store = new EmbeddingStore(db);
      store.upsert('node:a', 'hashA', new Float32Array([1, 0]));
      store.upsert('node:b', 'hashB', new Float32Array([0, 1]));
      const all = store.getAll();
      expect(all.length).toBeGreaterThanOrEqual(2);
      db.close();
    });

    it('contentHash is deterministic', () => {
      const node = {
        id: 'fn:test',
        properties: { name: 'myFunction', label: 'Function' },
      };
      const hash1 = EmbeddingStore.contentHash(node);
      const hash2 = EmbeddingStore.contentHash(node);
      expect(hash1).toBe(hash2);
    });

    it('getOrCompute caches by content hash', () => {
      const db = new Database(dbPath);
      const store = new EmbeddingStore(db);
      const index = buildTfIdfIndex([
        { nodeId: 'fn:x', text: 'test function' },
      ]);
      const provider = createTfIdfEmbeddingProvider(index);

      const node = { id: 'fn:x', properties: { name: 'test', label: 'Function' } };
      const vec1 = store.getOrCompute(node, provider);
      const vec2 = store.getOrCompute(node, provider);
      // Same hash → returned from cache, no error
      expect(vec1.length).toBe(vec2.length);
      db.close();
    });
  });

  describe('hybridSearch integration', () => {
    beforeAll(() => {
      testDir = mkdtempSync(join(tmpdir(), 'astrolabe-hybrid-'));
      dbPath = join(testDir, 'hybrid-test.db');
    });

    afterAll(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it('returns combined results from FTS and vector search', async () => {
      const store = createSqliteStore(dbPath);
      const graph = createKnowledgeGraph();
      graph.addNode({ id: 'fn:login', label: 'Function', properties: { name: 'loginHandler', filePath: 'src/auth.ts' } });
      graph.addNode({ id: 'fn:pay', label: 'Function', properties: { name: 'processPayment', filePath: 'src/billing.ts' } });
      store.saveGraph(graph);

      const fts = createFtsSearch(dbPath);
      fts.indexGraph(store);

      const db = new Database(dbPath);
      const embStore = new EmbeddingStore(db);
      const index = buildTfIdfIndex([
        { nodeId: 'fn:login', text: 'user authentication login handler' },
        { nodeId: 'fn:pay', text: 'payment billing invoice processor' },
      ]);
      const provider = createTfIdfEmbeddingProvider(index);

      const results = await hybridSearch('login', fts, embStore, provider, 10);
      expect(results.length).toBeGreaterThan(0);

      fts.close();
      store.close();
      db.close();
    });

    it('handles empty FTS results gracefully', async () => {
      const store = createSqliteStore(dbPath);
      const graph = createKnowledgeGraph();
      store.saveGraph(graph);
      const fts = createFtsSearch(dbPath);
      fts.indexGraph(store);

      const db = new Database(dbPath);
      const embStore = new EmbeddingStore(db);
      const index = buildTfIdfIndex([{ nodeId: 'fn:x', text: 'nonexistent term' }]);
      const provider = createTfIdfEmbeddingProvider(index);

      const results = await hybridSearch('zzzzzzzzz', fts, embStore, provider, 5);
      // Should not crash, may return empty
      expect(Array.isArray(results)).toBe(true);

      fts.close();
      store.close();
      db.close();
    });
  });
});
