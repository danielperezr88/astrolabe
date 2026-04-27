/**
 * Native binary preloader for better-sqlite3.
 *
 * Must be imported BEFORE any module that requires 'better-sqlite3'.
 * When running in VS Code's Electron, copies the electron-compiled
 * binary to the default location so that better-sqlite3's internal
 * bindings resolution finds the correct ABI binary.
 *
 * #220: Uses temp-file + rename for atomic copy (avoids TOCTOU race).
 * #224: Idempotent — only runs once per process via initialized guard.
 */

import { copyFileSync, renameSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

let initialized = false;

export function ensureNativeBinary(): void {
  if (initialized) return;
  initialized = true;
  if ('electron' in process.versions) {
    const req = createRequire(import.meta.url);
    try {
      const sidecar = req.resolve('better-sqlite3/build/Release/electron/better_sqlite3.node');
      const defaultBin = req.resolve('better-sqlite3/build/Release/better_sqlite3.node');
      if (sidecar && existsSync(sidecar) && defaultBin) {
        // #220: Write to temp file then rename — atomic on NTFS, avoids partial-read race
        const tmp = defaultBin + '.tmp-' + Date.now();
        copyFileSync(sidecar, tmp);
        renameSync(tmp, defaultBin);
      }
    } catch { /* non-fatal — will fall back to system binary */ }
  }
}

// Trigger at import time so the binary is in place before better-sqlite3 loads.
// On CLI/tests (Node.js) this is a single boolean check; no fs/module work done.
if ('electron' in process.versions) ensureNativeBinary();
