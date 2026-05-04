/**
 * Tests for the AST tree cache (AstCache).
 *
 * Exercises LRU eviction, WASM tree disposal, getOrParse, and
 * singleton behaviour using mock tree objects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AstCache, astCache, type AstCacheEntry } from '../../src/analysis/ast-cache.js';

// ── Mock tree factory ────────────────────────────────────────────────────────

/**
 * Create a mock Tree-sitter Tree object with a `.delete()` spy.
 * Optionally includes `rootNode.descendantCount` for size estimation.
 */
function mockTree(descendantCount = 100): { delete: ReturnType<typeof vi.fn>; rootNode: { descendantCount: number } } {
  return {
    delete: vi.fn(),
    rootNode: { descendantCount },
  };
}

/**
 * Create a plain object tree (no .delete() method).
 * Used to verify the cache is safe with non-WASM trees.
 */
function plainTree(): { rootNode: { descendantCount: number } } {
  return { rootNode: { descendantCount: 50 } };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AstCache', () => {
  let cache: AstCache;

  beforeEach(() => {
    cache = new AstCache(5); // small cache for LRU testing
  });

  // ── Constructor ────────────────────────────────────────────────────────────

  it('defaults to 50 max entries', () => {
    const defaultCache = new AstCache();
    expect(defaultCache.maxSize).toBe(50);
  });

  it('accepts a custom maxEntries value', () => {
    const custom = new AstCache(10);
    expect(custom.maxSize).toBe(10);
  });

  it('throws if maxEntries is less than 1', () => {
    expect(() => new AstCache(0)).toThrow(RangeError);
    expect(() => new AstCache(-1)).toThrow(RangeError);
  });

  // ── set / get ───────────────────────────────────────────────────────────────

  it('stores and retrieves a tree by file path', () => {
    const tree = mockTree();
    cache.set('/src/foo.ts', tree);

    const entry = cache.get('/src/foo.ts');
    expect(entry).toBeDefined();
    expect(entry!.tree).toBe(tree);
    expect(entry!.filePath).toBe('/src/foo.ts');
    expect(entry!.cachedAt).toBeGreaterThan(0);
  });

  it('returns undefined for a missing key', () => {
    expect(cache.get('/nonexistent.ts')).toBeUndefined();
  });

  // ── has ─────────────────────────────────────────────────────────────────────

  it('has() returns true for cached paths, false otherwise', () => {
    cache.set('/src/a.ts', mockTree());
    expect(cache.has('/src/a.ts')).toBe(true);
    expect(cache.has('/src/b.ts')).toBe(false);
  });

  // ── size ────────────────────────────────────────────────────────────────────

  it('reports correct size', () => {
    expect(cache.size).toBe(0);
    cache.set('/a.ts', mockTree());
    expect(cache.size).toBe(1);
    cache.set('/b.ts', mockTree());
    expect(cache.size).toBe(2);
  });

  // ── totalSizeBytes ──────────────────────────────────────────────────────────

  it('tracks approximate total size in bytes', () => {
    const tree1 = mockTree(100); // 100 * 64 = 6400
    cache.set('/a.ts', tree1);
    expect(cache.totalSizeBytes).toBe(6400);

    const tree2 = mockTree(200); // 200 * 64 = 12800
    cache.set('/b.ts', tree2);
    expect(cache.totalSizeBytes).toBe(6400 + 12800);
  });

  // ── delete ──────────────────────────────────────────────────────────────────

  it('delete() removes an entry and calls tree.delete()', () => {
    const tree = mockTree();
    cache.set('/src/x.ts', tree);
    expect(cache.has('/src/x.ts')).toBe(true);

    cache.delete('/src/x.ts');
    expect(cache.has('/src/x.ts')).toBe(false);
    expect(tree.delete).toHaveBeenCalledTimes(1);
  });

  it('delete() is a no-op for a non-existent key', () => {
    expect(() => cache.delete('/nope.ts')).not.toThrow();
  });

  // ── clear ────────────────────────────────────────────────────────────────────

  it('clear() removes all entries and disposes all trees', () => {
    const t1 = mockTree();
    const t2 = mockTree();
    const t3 = mockTree();
    cache.set('/a.ts', t1);
    cache.set('/b.ts', t2);
    cache.set('/c.ts', t3);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.totalSizeBytes).toBe(0);
    expect(t1.delete).toHaveBeenCalledTimes(1);
    expect(t2.delete).toHaveBeenCalledTimes(1);
    expect(t3.delete).toHaveBeenCalledTimes(1);
  });

  // ── LRU eviction ────────────────────────────────────────────────────────────

  it('evicts the oldest entry when cache exceeds maxEntries', () => {
    const trees = Array.from({ length: 6 }, () => mockTree());
    // Cache has maxEntries=5; inserting 6 should evict the first
    for (let i = 0; i < 6; i++) {
      cache.set(`/file${i}.ts`, trees[i]);
    }

    // file0 should have been evicted
    expect(cache.has('/file0.ts')).toBe(false);
    // file1–file5 should remain
    expect(cache.has('/file5.ts')).toBe(true);
    // The evicted tree should have .delete() called
    expect(trees[0].delete).toHaveBeenCalledTimes(1);
  });

  it('LRU refresh: get() moves entry to most-recently-used position', () => {
    const trees = Array.from({ length: 5 }, () => mockTree());
    for (let i = 0; i < 5; i++) {
      cache.set(`/file${i}.ts`, trees[i]);
    }

    // Access file0 to make it most-recently-used
    cache.get('/file0.ts');

    // Insert a 6th entry — should evict file1 (now the LRU), not file0
    const tree6 = mockTree();
    cache.set('/file6.ts', tree6);

    expect(cache.has('/file0.ts')).toBe(true);  // refreshed, not evicted
    expect(cache.has('/file1.ts')).toBe(false); // oldest, evicted
    expect(trees[1].delete).toHaveBeenCalledTimes(1);
  });

  // ── set with existing key ───────────────────────────────────────────────────

  it('replacing an existing key disposes the old tree', () => {
    const oldTree = mockTree();
    const newTree = mockTree();
    cache.set('/src/same.ts', oldTree);
    cache.set('/src/same.ts', newTree);

    expect(cache.size).toBe(1);
    expect(cache.get('/src/same.ts')!.tree).toBe(newTree);
    expect(oldTree.delete).toHaveBeenCalledTimes(1);
  });

  // ── getOrParse ──────────────────────────────────────────────────────────────

  it('getOrParse() returns cached tree without calling parser', () => {
    const tree = mockTree();
    cache.set('/cached.ts', tree);

    const parser = vi.fn();
    const result = cache.getOrParse('/cached.ts', parser);

    expect(result).toBe(tree);
    expect(parser).not.toHaveBeenCalled();
  });

  it('getOrParse() calls parser for missing key and caches result', () => {
    const freshTree = mockTree(250);
    const parser = vi.fn().mockReturnValue(freshTree);

    const result = cache.getOrParse('/fresh.ts', parser);

    expect(result).toBe(freshTree);
    expect(parser).toHaveBeenCalledTimes(1);
    expect(parser).toHaveBeenCalledWith('/fresh.ts');
    expect(cache.has('/fresh.ts')).toBe(true);
    expect(cache.get('/fresh.ts')!.tree).toBe(freshTree);
  });

  it('getOrParse() does not cache null or undefined parser results', () => {
    const parserNull = vi.fn().mockReturnValue(null);
    const result = cache.getOrParse('/null.ts', parserNull);

    expect(result).toBeNull();
    expect(cache.has('/null.ts')).toBe(false);
  });

  // ── WASM tree disposal safety ──────────────────────────────────────────────

  it('handles trees without a .delete() method gracefully', () => {
    const tree = plainTree(); // no .delete()
    cache.set('/plain.ts', tree);

    // Should not throw when clearing
    expect(() => cache.clear()).not.toThrow();
    expect(cache.size).toBe(0);
  });

  // ── Singleton ──────────────────────────────────────────────────────────────

  it('exports a singleton astCache instance', () => {
    expect(astCache).toBeInstanceOf(AstCache);
  });
});
