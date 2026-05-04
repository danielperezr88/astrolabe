/**
 * Astrolabe — AST tree cache with LRU eviction.
 *
 * Caches parsed Tree-sitter AST trees so downstream pipeline phases
 * can reuse parsed trees without re-parsing from disk.
 *
 * LRU policy: Map preserves insertion order; on access we delete + re-set
 * to move the entry to the most-recently-used position. When the cache
 * exceeds `maxEntries`, the oldest entry (least recently used) is evicted.
 *
 * WASM tree disposal: Tree-sitter Tree objects have a `.delete()` method
 * for freeing native memory. When evicting or clearing, we call
 * `tree.delete()` if it exists to avoid WASM memory leaks.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A cached Tree-sitter AST tree entry.
 */
export interface AstCacheEntry {
  /** The Tree-sitter Tree object. */
  tree: unknown;
  /** Absolute file path (cache key). */
  filePath: string;
  /** Approximate size in bytes (estimated from tree node count). */
  size: number;
  /** Timestamp when the entry was cached (epoch ms). */
  cachedAt: number;
}

// ── AstCache class ──────────────────────────────────────────────────────────

/**
 * LRU cache for Tree-sitter AST trees.
 *
 * Designed for use within a single pipeline run: the pipeline creates a
 * fresh instance before executing phases, stores it in `context.state`,
 * and clears it (disposing all trees) after phases complete.
 *
 * Thread-safety: Not designed for concurrent writes. The pipeline already
 * serialises phase execution so this is safe.
 */
export class AstCache {
  private readonly cache: Map<string, AstCacheEntry> = new Map();
  private readonly maxEntries: number;
  private totalSize = 0;

  constructor(maxEntries = 50) {
    if (maxEntries < 1) {
      throw new RangeError('AstCache maxEntries must be at least 1');
    }
    this.maxEntries = maxEntries;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Get a cached tree or parse fresh from the file.
   *
   * If the file is already cached, returns the cached tree (and moves the
   * entry to the most-recently-used position). Otherwise calls `parser`
   * to produce a fresh tree, caches it, and returns it.
   *
   * @param filePath  Absolute file path (used as cache key).
   * @param parser    Function that parses the file and returns a Tree-sitter Tree.
   * @returns The Tree-sitter Tree object.
   */
  getOrParse(filePath: string, parser: (filePath: string) => unknown): unknown {
    const cached = this.get(filePath);
    if (cached) return cached.tree;

    const tree = parser(filePath);
    if (tree !== undefined && tree !== null) {
      this.set(filePath, tree);
    }
    return tree;
  }

  /**
   * Get a cached entry if it exists.
   *
   * Moves the entry to the most-recently-used position (LRU refresh).
   */
  get(filePath: string): AstCacheEntry | undefined {
    const entry = this.cache.get(filePath);
    if (!entry) return undefined;

    // LRU refresh: delete and re-set moves entry to end of Map
    this.cache.delete(filePath);
    this.cache.set(filePath, entry);
    return entry;
  }

  /**
   * Manually set a cache entry.
   *
   * If the file is already cached, the old tree is disposed before
   * being replaced. If the cache is at capacity, the least recently
   * used entry is evicted (with tree disposal).
   */
  set(filePath: string, tree: unknown): void {
    // If already cached, dispose old tree first
    const existing = this.cache.get(filePath);
    if (existing) {
      this.disposeTree(existing.tree);
      this.totalSize -= existing.size;
      this.cache.delete(filePath);
    }

    // Evict LRU entry if at capacity
    if (this.cache.size >= this.maxEntries) {
      this.evictOldest();
    }

    // Estimate size from tree node count if available
    const size = estimateTreeSize(tree);

    const entry: AstCacheEntry = {
      tree,
      filePath,
      size,
      cachedAt: Date.now(),
    };

    this.cache.set(filePath, entry);
    this.totalSize += size;
  }

  /**
   * Check if a file is cached.
   */
  has(filePath: string): boolean {
    return this.cache.has(filePath);
  }

  /**
   * Invalidate a specific entry, disposing the WASM tree.
   */
  delete(filePath: string): void {
    const entry = this.cache.get(filePath);
    if (!entry) return;

    this.disposeTree(entry.tree);
    this.totalSize -= entry.size;
    this.cache.delete(filePath);
  }

  /**
   * Clear the entire cache, disposing all WASM trees.
   */
  clear(): void {
    for (const entry of this.cache.values()) {
      this.disposeTree(entry.tree);
    }
    this.cache.clear();
    this.totalSize = 0;
  }

  /**
   * Current number of cached entries.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Total approximate size of all cached trees in bytes.
   */
  get totalSizeBytes(): number {
    return this.totalSize;
  }

  /**
   * Maximum number of entries this cache can hold.
   */
  get maxSize(): number {
    return this.maxEntries;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Evict the oldest (least recently used) entry from the cache.
   * Disposes the evicted tree's WASM memory.
   */
  private evictOldest(): void {
    // Map iterates in insertion order; first key = oldest
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      const entry = this.cache.get(firstKey);
      if (entry) {
        this.disposeTree(entry.tree);
        this.totalSize -= entry.size;
      }
      this.cache.delete(firstKey);
    }
  }

  /**
   * Dispose a Tree-sitter Tree object by calling `.delete()` if available.
   *
   * Tree-sitter WASM trees must be explicitly freed to release native memory.
   * The `.delete()` method is safe to call multiple times (idempotent in
   * most tree-sitter bindings), but we guard against missing methods just
   * in case the tree object is a mock or from a different source.
   */
  private disposeTree(tree: unknown): void {
    if (
      tree !== null &&
      tree !== undefined &&
      typeof (tree as { delete?: unknown }).delete === 'function'
    ) {
      (tree as { delete: () => void }).delete();
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Estimate the approximate memory size of a Tree-sitter tree in bytes.
 *
 * Uses `rootNode.descendantCount` if available (tree-sitter provides this),
 * otherwise falls back to a rough per-node estimate.
 * Each node is estimated at ~64 bytes (a typical tree-sitter node struct).
 */
function estimateTreeSize(tree: unknown): number {
  if (tree === null || tree === undefined) return 0;

  const t = tree as Record<string, unknown>;

  // Try rootNode.descendantCount — most accurate
  if (
    typeof t.rootNode === 'object' &&
    t.rootNode !== null &&
    typeof (t.rootNode as Record<string, unknown>).descendantCount === 'number'
  ) {
    return (t.rootNode as Record<string, unknown>).descendantCount as number * 64;
  }

  // Try rootNode.childCount as a rough lower bound
  if (
    typeof t.rootNode === 'object' &&
    t.rootNode !== null &&
    typeof (t.rootNode as Record<string, unknown>).childCount === 'number'
  ) {
    return (t.rootNode as Record<string, unknown>).childCount as number * 256;
  }

  // Fallback: assume a moderate tree size
  return 4096;
}

// ── Singleton instance ──────────────────────────────────────────────────────

/**
 * Singleton AST cache instance for pipeline use.
 *
 * The pipeline creates a fresh instance before running phases and clears
 * it after completion. The singleton is provided as a convenience for
 * modules that need access outside the pipeline context (e.g. parser.ts).
 */
export const astCache: AstCache = new AstCache();
