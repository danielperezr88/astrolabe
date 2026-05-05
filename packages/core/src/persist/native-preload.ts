/**
 * Native binary preloader for better-sqlite3.
 *
 * Must be imported BEFORE any module that requires 'better-sqlite3'.
 * Handles two directions:
 *
 *   Electron (VSCode): saves the node-v137 binary as a backup, then atomically
 *   replaces the default location with the electron-v140 binary.
 *
 *   Node.js (CLI/tests): detects if the default location was overwritten by a
 *   previous VSCode run and restores the node-v137 binary from backup.
 *
 * #220: Uses temp-file + rename for atomic copy (avoids TOCTOU race).
 * #224: Idempotent — only runs once per process via initialized guard.
 */

import { copyFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createLogger } from '../logging/index.js';

const log = createLogger({ level: 'debug' });

let initialized = false;

export function ensureNativeBinary(): void {
  if (initialized) return;
  initialized = true;

  const req = createRequire(import.meta.url);
  try {
    const defaultBin: string = req.resolve('better-sqlite3/build/Release/better_sqlite3.node');
    const baseDir = dirname(defaultBin);
    const nodeBackup = join(baseDir, 'node', 'better_sqlite3.node');
    const electronSidecar = join(baseDir, 'electron', 'better_sqlite3.node');

    if ('electron' in process.versions) {
      // ── Electron (VSCode): swap to electron binary ──
      if (existsSync(electronSidecar)) {
        // Save node binary as backup if not already saved (survives overwrite)
        if (existsSync(defaultBin) && !existsSync(nodeBackup)) {
          mkdirSync(dirname(nodeBackup), { recursive: true });
          copyFileSync(defaultBin, nodeBackup);
        }
        // Atomic replace with electron binary (#227: cleanup temp on rename failure)
        const tmp = defaultBin + '.tmp-' + Date.now();
        try { copyFileSync(electronSidecar, tmp); renameSync(tmp, defaultBin); }
        finally { try { unlinkSync(tmp); } catch (err) { log.debug('Temp file already cleaned up', { path: tmp, error: String(err) }); } }
      }
    } else if (existsSync(nodeBackup)) {
      // ── Node.js (CLI/tests): restore node binary from backup (#227: cleanup temp on rename failure)
      const tmp = defaultBin + '.tmp-' + Date.now();
      try { copyFileSync(nodeBackup, tmp); renameSync(tmp, defaultBin); }
      finally { try { unlinkSync(tmp); } catch (err) { log.debug('Temp file already cleaned up', { path: tmp, error: String(err) }); } }
    }
  } catch (err) {
    // #308: Log the error instead of silently swallowing — helps diagnose permission/disk issues
    try { console.warn('[astrolabe/native-preload] Binary preload failed:', (err as Error).message); } catch (logErr) { log.debug('Binary preload failed and logging unavailable', { error: String(err) }); }
  }
}

// Trigger at import time so the binary is in place before better-sqlite3 loads.
ensureNativeBinary();
