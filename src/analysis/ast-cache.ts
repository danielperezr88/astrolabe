/**
 * Astrolabe — AST cache.
 *
 * Simple content-addressable cache keyed by file path + last-modified time.
 * Stores parsed results so that re-parsing unchanged files is a no-op.
 */

import type { FileParseResult } from './language-definition.js';

interface CacheEntry {
  /** File modification time (epoch ms) at time of parsing. */
  mtimeMs: number;
  /** The cached parse result. */
  result: FileParseResult;
}

/**
 * In-memory cache for file parse results.
 *
 * Thread-safe for reads (concurrent lookups on the same key are fine).
 * Not designed for concurrent writes — callers should serialise writes
 * per file (the pipeline already does this).
 */
export class AstCache {
  private readonly _store = new Map<string, CacheEntry>();

  /**
   * Retrieve a cached result if the file is unchanged.
   *
   * @param filePath  Normalised absolute path.
   * @param mtimeMs   Current file modification time (epoch ms).
   * @returns Cached result, or `undefined` if missing / stale.
   */
  get(filePath: string, mtimeMs: number): FileParseResult | undefined {
    const entry = this._store.get(filePath);
    if (!entry) return undefined;
    // Invalidate if file has changed since we cached it
    if (entry.mtimeMs !== mtimeMs) {
      this._store.delete(filePath);
      return undefined;
    }
    return entry.result;
  }

  /**
   * Store a parse result.
   */
  set(filePath: string, mtimeMs: number, result: FileParseResult): void {
    this._store.set(filePath, { mtimeMs, result });
  }

  /**
   * Invalidate a specific file entry.
   * Call this when a file is known to have changed.
   */
  invalidate(filePath: string): void {
    this._store.delete(filePath);
  }

  /**
   * Invalidate all entries.
   */
  clear(): void {
    this._store.clear();
  }

  /**
   * Number of cached entries.
   */
  get size(): number {
    return this._store.size;
  }
}
