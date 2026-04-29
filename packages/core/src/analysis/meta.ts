/**
 * Meta.json — incremental indexing support (#280).
 *
 * Stores per-file content hashes alongside the SQLite database in
 * `.astrolabe/meta.json`. On re-analysis, file hashes are compared
 * to detect changed, added, and deleted files, enabling incremental
 * re-analysis that only processes files that actually changed.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

// ── Types ──────────────────────────────────────────────────────────────────

export interface MetaFile {
  /** Schema version for forward-compatibility. */
  version: 1;
  /** Map of repo-relative path → SHA256 hex digest. */
  hashes: Record<string, string>;
  /** When the full analysis was last run (epoch ms). */
  lastFullAnalysis: number;
  /** git HEAD commit at time of last full analysis. */
  lastCommit: string;
}

export interface FileDiff {
  /** Files with changed content (hash differs from stored). */
  changed: string[];
  /** New files not present in stored hashes. */
  added: string[];
  /** Files removed since last analysis. */
  deleted: string[];
  /** Files with unchanged content. */
  unchanged: string[];
}

// ── I/O ─────────────────────────────────────────────────────────────────────

/**
 * Load meta.json from the given directory (typically `.astrolabe/`).
 * Returns null if the file doesn't exist or is corrupted.
 */
export function loadMeta(metaDir: string): MetaFile | null {
  const path = `${metaDir}/meta.json`;
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const obj = JSON.parse(raw);
    if (obj?.version === 1 && typeof obj.hashes === 'object' && obj.hashes !== null) {
      return obj as MetaFile;
    }
    return null;
  } catch {
    return null; // corrupted — will trigger full re-analysis
  }
}

/**
 * Save meta.json to the given directory.
 * Creates the directory if it doesn't exist.
 */
export function saveMeta(metaDir: string, meta: MetaFile): void {
  const dir = metaDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2), 'utf-8');
}

// ── Diff computation ────────────────────────────────────────────────────────

/**
 * Compare current file hashes with stored hashes to produce a diff.
 *
 * @param currentHashes — Map of path → SHA256 from the current scan
 * @param storedMeta — Previously saved MetaFile, or null for first run
 * @returns FileDiff identifying changed, added, deleted, and unchanged files
 */
export function computeFileDiff(
  currentHashes: Map<string, string>,
  storedMeta: MetaFile | null,
): FileDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];

  for (const [path, hash] of currentHashes) {
    const storedHash = storedMeta?.hashes[path];
    if (storedHash === undefined) {
      added.push(path);
    } else if (storedHash !== hash) {
      changed.push(path);
    } else {
      unchanged.push(path);
    }
  }

  const deleted: string[] = [];
  if (storedMeta) {
    for (const path of Object.keys(storedMeta.hashes)) {
      if (!currentHashes.has(path)) {
        deleted.push(path);
      }
    }
  }

  return { changed, added, deleted, unchanged };
}

/**
 * Build a MetaFile from current scan results and metadata.
 */
export function buildMeta(
  hashes: Map<string, string>,
  lastCommit: string,
): MetaFile {
  return {
    version: 1,
    hashes: Object.fromEntries(hashes),
    lastFullAnalysis: Date.now(),
    lastCommit,
  };
}
