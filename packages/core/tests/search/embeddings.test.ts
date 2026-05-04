/**
 * Tests for TF-IDF embeddings and cosine similarity search.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTfIdfIndex, searchTfIdf, cosineSimilarity } from '../../src/search/embeddings.js';
import { EmbeddingStore, createTfIdfEmbeddingProvider } from '../../src/search/embeddings-store.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('TF-IDF Embeddings', () => {
  it('builds index from document texts', () => {
    const docs = [
      { nodeId: 'fn:a', text: 'function handles user authentication and login' },
      { nodeId: 'fn:b', text: 'function processes payment and billing' },
      { nodeId: 'fn:c', text: 'function searches database for user records' },
    ];

    const idx = buildTfIdfIndex(docs);
    expect(idx.vectors.size).toBe(3);
    expect(idx.vectors.get('fn:a')!.weights.size).toBeGreaterThan(0);
  });

  it('finds relevant documents via cosine similarity', () => {
    const docs = [
      { nodeId: 'fn:a', text: 'user authentication login handler' },
      { nodeId: 'fn:b', text: 'payment billing invoice processor' },
      { nodeId: 'fn:c', text: 'database search query index' },
    ];

    const idx = buildTfIdfIndex(docs);
    const results = searchTfIdf('user login authentication', idx, 10);

    expect(results.length).toBeGreaterThan(0);
    // fn:a should be the best match since it shares "user", "authentication", "login"
    expect(results[0].nodeId).toBe('fn:a');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('cosine similarities are in [0,1] range', () => {
    const a_val = new Map([['user', 0.5], ['login', 0.3]]);
    const b_val = new Map([['user', 0.4], ['payment', 0.6]]);

    const sim = cosineSimilarity(a_val, 1.0, b_val, 1.0);
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it('handles empty query', () => {
    const idx = buildTfIdfIndex([{ nodeId: 'fn:a', text: 'hello world' }]);
    const results = searchTfIdf('', idx);
    expect(results).toHaveLength(0);
  });

  it('handles empty document set', () => {
    const idx = buildTfIdfIndex([]);
    expect(idx.vectors.size).toBe(0);
  });
});

// ── Embedding preservation during re-analysis ─────────────────────────────────

describe('Embedding Preservation during Re-analysis', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'astrolabe-emb-preserve-'));
  });

  afterAll(() => {
    // Retry cleanup on Windows — SQLite files may be briefly locked
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  /** Create a fresh database with its own file for test isolation. */
  function freshDb(tag: string): { db: Database.Database; path: string } {
    const p = join(testDir, `preserve-${tag}-${Date.now()}.db`);
    const db = new Database(p);
    return { db, path: p };
  }

  it('getExistingHashes returns all stored content hashes as a Map', () => {
    const { db } = freshDb('hashes');
    const store = new EmbeddingStore(db);
    store.upsert('node:1', 'hash_aaa', new Float32Array([0.1, 0.2]));
    store.upsert('node:2', 'hash_bbb', new Float32Array([0.3, 0.4]));
    store.upsert('node:3', 'hash_ccc', new Float32Array([0.5, 0.6]));

    const hashes = store.getExistingHashes();
    expect(hashes).toBeInstanceOf(Map);
    expect(hashes.size).toBe(3);
    expect(hashes.get('node:1')).toBe('hash_aaa');
    expect(hashes.get('node:2')).toBe('hash_bbb');
    expect(hashes.get('node:3')).toBe('hash_ccc');
    db.close();
  });

  it('getExistingHashes returns empty Map when no embeddings stored', () => {
    const { db } = freshDb('empty');
    const store = new EmbeddingStore(db);

    const hashes = store.getExistingHashes();
    expect(hashes).toBeInstanceOf(Map);
    expect(hashes.size).toBe(0);
    db.close();
  });

  it('needsReembedding returns true when node has no stored embedding', () => {
    const { db } = freshDb('missing');
    const store = new EmbeddingStore(db);

    expect(store.needsReembedding('node:never_existed', 'any_hash')).toBe(true);
    db.close();
  });

  it('needsReembedding returns true when content hash differs', () => {
    const { db } = freshDb('diff-hash');
    const store = new EmbeddingStore(db);
    store.upsert('node:1', 'hash_old', new Float32Array([0.1, 0.2]));

    expect(store.needsReembedding('node:1', 'hash_new')).toBe(true);
    db.close();
  });

  it('needsReembedding returns false when content hash matches (embedding preserved)', () => {
    const { db } = freshDb('same-hash');
    const store = new EmbeddingStore(db);
    store.upsert('node:1', 'hash_match', new Float32Array([0.1, 0.2]));

    expect(store.needsReembedding('node:1', 'hash_match')).toBe(false);
    db.close();
  });

  it('detectDimensionMismatch returns false when no embeddings are stored', () => {
    const { db } = freshDb('dim-empty');
    const store = new EmbeddingStore(db);

    expect(store.detectDimensionMismatch(384)).toBe(false);
    db.close();
  });

  it('detectDimensionMismatch returns false when all embeddings match current dims', () => {
    const { db } = freshDb('dim-match');
    const store = new EmbeddingStore(db);
    store.upsert('node:1', 'h1', new Float32Array(384));
    store.upsert('node:2', 'h2', new Float32Array(384));

    expect(store.detectDimensionMismatch(384)).toBe(false);
    db.close();
  });

  it('detectDimensionMismatch returns true when stored dims differ from current provider', () => {
    const { db } = freshDb('dim-differ');
    const store = new EmbeddingStore(db);
    store.upsert('node:1', 'h1', new Float32Array(384));
    store.upsert('node:2', 'h2', new Float32Array(384));

    expect(store.detectDimensionMismatch(768)).toBe(true);
    db.close();
  });

  it('detectDimensionMismatch detects mixed dimensionality as mismatch', () => {
    const { db } = freshDb('dim-mixed');
    const store = new EmbeddingStore(db);
    store.upsert('node:1', 'h1', new Float32Array(384));
    store.upsert('node:2', 'h2', new Float32Array(768));

    expect(store.detectDimensionMismatch(384)).toBe(true);
    db.close();
  });

  it('clearAll removes all stored embeddings', () => {
    const { db } = freshDb('clear');
    const store = new EmbeddingStore(db);
    store.upsert('node:1', 'h1', new Float32Array([0.1]));
    store.upsert('node:2', 'h2', new Float32Array([0.2]));
    store.upsert('node:3', 'h3', new Float32Array([0.3]));

    expect(store.getAll().length).toBe(3);
    store.clearAll();
    expect(store.getAll().length).toBe(0);
    expect(store.getExistingHashes().size).toBe(0);
    db.close();
  });

  it('full re-analysis workflow: dimension mismatch triggers clear + rebuild', () => {
    const { db } = freshDb('workflow-dims');
    const store = new EmbeddingStore(db);
    const index = buildTfIdfIndex([
      { nodeId: 'fn:a', text: 'user authentication login handler' },
    ]);
    const provider384 = createTfIdfEmbeddingProvider(index);

    // Initial embedding with whatever dims the TF-IDF provider uses
    const node1 = { id: 'fn:a', properties: { name: 'loginHandler', label: 'Function' } };
    store.getOrCompute(node1, provider384);

    // Verify embedding exists
    expect(store.get('fn:a')).not.toBeNull();
    const originalDims = provider384.dimensions;

    // Simulate model upgrade: detect mismatch
    const newDims = originalDims + 100;
    expect(store.detectDimensionMismatch(newDims)).toBe(true);

    // Clear and rebuild
    store.clearAll();
    expect(store.getAll().length).toBe(0);

    // Re-embed with new provider dimensions (using a dummy provider)
    const dummyProvider = {
      dimensions: newDims,
      encode: (_text: string) => new Float32Array(newDims),
    };
    const vec = store.getOrCompute(node1, dummyProvider);
    expect(vec.length).toBe(newDims);
    expect(store.get('fn:a')!.dimensions).toBe(newDims);

    db.close();
  });

  it('full re-analysis workflow: unchanged nodes skip re-embedding', () => {
    const { db } = freshDb('workflow-skip');
    const store = new EmbeddingStore(db);
    const index = buildTfIdfIndex([
      { nodeId: 'fn:a', text: 'user authentication login handler' },
      { nodeId: 'fn:b', text: 'payment billing processor' },
    ]);
    const provider = createTfIdfEmbeddingProvider(index);

    // Initial embedding
    const nodeA = { id: 'fn:a', properties: { name: 'loginHandler', label: 'Function' } };
    const nodeB = { id: 'fn:b', properties: { name: 'processPayment', label: 'Function' } };
    const vecA1 = store.getOrCompute(nodeA, provider);
    const vecB1 = store.getOrCompute(nodeB, provider);

    // Simulate re-analysis: nodeA unchanged, nodeB changed
    const nodeAUpdated = { id: 'fn:a', properties: { name: 'loginHandler', label: 'Function' } }; // same
    const nodeBUpdated = { id: 'fn:b', properties: { name: 'processRefund', label: 'Function' } }; // changed!

    // Check which need re-embedding using batch method
    const existingHashes = store.getExistingHashes();
    const hashA = EmbeddingStore.contentHash(nodeAUpdated);
    const hashB = EmbeddingStore.contentHash(nodeBUpdated);

    expect(existingHashes.get('fn:a')).toBe(hashA); // unchanged
    expect(existingHashes.get('fn:b')).not.toBe(hashB); // changed

    // Use needsReembedding for individual checks
    expect(store.needsReembedding('fn:a', hashA)).toBe(false);
    expect(store.needsReembedding('fn:b', hashB)).toBe(true);

    // Re-embed only the changed node
    const vecA2 = store.getOrCompute(nodeAUpdated, provider);
    const vecB2 = store.getOrCompute(nodeBUpdated, provider);

    // vecA should be identical (cached), vecB should differ
    expect(vecA1).toEqual(vecA2);
    // vecB1 and vecB2 have different content but same dimensions
    expect(vecB1.length).toBe(vecB2.length);

    db.close();
  });
});
