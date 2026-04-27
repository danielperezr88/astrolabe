/**
 * Post-install: ensure better-sqlite3 has the correct native binary.
 *
 * Downloads TWO prebuilt binaries:
 *   1. node-v137: system Node.js (CLI, tests)
 *   2. electron-v140: VS Code's Electron (saved as sidecar)
 *
 * At runtime, packages/core/src/persist/sqlite.ts detects whether it's
 * running in Electron and loads the appropriate binary automatically.
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '12.9.0';
const PLATFORM = process.platform;
const ARCH = process.arch;

function platStr() {
  if (PLATFORM === 'win32') return 'win32';
  if (PLATFORM === 'darwin') return 'darwin';
  return 'linux';
}

function archStr() {
  if (ARCH === 'x64') return 'x64';
  if (ARCH === 'arm64') return 'arm64';
  return 'x64';
}

const P = platStr(), A = archStr();

const BINARIES = [
  { name: 'node-v137', file: 'better-sqlite3-v' + VERSION + '-node-v137-' + P + '-' + A + '.tar.gz', dest: '' },
  { name: 'electron-v140', file: 'better-sqlite3-v' + VERSION + '-electron-v140-' + P + '-' + A + '.tar.gz', dest: 'electron' },
];

function findBetterSqlite3Dir() {
  const candidates = [
    join(ROOT, 'packages', 'core', 'node_modules', 'better-sqlite3'),
    join(ROOT, 'node_modules', 'better-sqlite3'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { file.close(); reject(new Error('HTTP ' + res.statusCode)); return; }
      pipeline(res, file).then(resolve, reject);
    }).on('error', reject);
  });
}

function findNode(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === 'better_sqlite3.node') return p;
    if (e.isDirectory()) { const r = findNode(p); if (r) return r; }
  }
  return null;
}

async function installBinary(bin) {
  const baseDir = findBetterSqlite3Dir();
  const subDir = bin.dest ? join('build', 'Release', bin.dest) : join('build', 'Release');
  const nodeFile = join(baseDir, subDir, 'better_sqlite3.node');

  if (existsSync(nodeFile)) {
    try { if (statSync(nodeFile).size > 500000) return; } catch { /* reinstall */ }
  }

  const url = 'https://github.com/WiseLibs/better-sqlite3/releases/download/v' + VERSION + '/' + bin.file;
  const tmpDir = join(ROOT, 'node_modules', '.tmp-bs3-' + bin.name);

  console.log('[astrolabe] Downloading ' + bin.name + ' binary...');
  try {
    mkdirSync(tmpDir, { recursive: true });
    const tarball = join(tmpDir, 'bs3.tar.gz');
    await download(url, tarball);

    const r = spawnSync('tar', ['-xzf', tarball, '-C', tmpDir], { stdio: 'pipe', timeout: 30000 });
    if (r.status !== 0 && PLATFORM === 'win32') {
      spawnSync('powershell', ['-Command', "tar -xzf '" + tarball + "' -C '" + tmpDir + "'"], { stdio: 'pipe', shell: true });
    }

    const src = findNode(tmpDir);
    if (!src) throw new Error('Could not find better_sqlite3.node in tarball');

    mkdirSync(join(baseDir, subDir), { recursive: true });
    copyFileSync(src, nodeFile);
    console.log('[astrolabe]   installed ' + bin.name + ' to ' + nodeFile);
  } catch (err) {
    console.error('[astrolabe] Failed to install ' + bin.name + ': ' + err.message);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

async function main() {
  for (const bin of BINARIES) {
    await installBinary(bin);
  }
  console.log('[astrolabe] Native binaries ready.');
}

main();
