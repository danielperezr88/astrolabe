/**
 * Native binary preloader for better-sqlite3.
 *
 * Must be imported BEFORE any module that requires 'better-sqlite3'.
 * When running in VS Code's Electron, copies the electron-compiled
 * binary to the default location so that better-sqlite3's internal
 * bindings resolution finds the correct ABI binary.
 */

import { copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

if ('electron' in process.versions) {
  const req = createRequire(import.meta.url);
  try {
    const sidecar = req.resolve('better-sqlite3/build/Release/electron/better_sqlite3.node');
    const defaultBin = req.resolve('better-sqlite3/build/Release/better_sqlite3.node');
    if (sidecar && existsSync(sidecar) && defaultBin) {
      copyFileSync(sidecar, defaultBin);
    }
  } catch { /* non-fatal — will fall back to system binary */ }
}
