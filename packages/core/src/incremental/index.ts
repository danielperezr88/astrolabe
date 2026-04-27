/**
 * Incremental indexing support.
 *
 * Tracks file hashes to determine which files changed since last analysis,
 * enabling incremental re-indexing instead of full rebuilds.
 *
 * Already partially implemented via SqliteStore.saveFileHash/getFileHash/
 * getChangedFiles. This module adds the orchestration layer.
 */
import type { SqliteStore } from '../persist/sqlite.js';
import type { FileEntry } from '../analysis/phases/scan.js';

export interface IncrementalState {
  changedFiles: FileEntry[];
  unchangedFiles: FileEntry[];
  isIncremental: boolean;
}

export function detectChanges(store: SqliteStore, files: FileEntry[]): IncrementalState {
  const changed = store.getChangedFiles(files.map((f) => ({ path: f.path, hash: f.hash })));
  const changedSet = new Set(changed.map((c) => c.path));
  return {
    changedFiles: files.filter((f) => changedSet.has(f.path)),
    unchangedFiles: files.filter((f) => !changedSet.has(f.path)),
    isIncremental: changed.length < files.length,
  };
}
