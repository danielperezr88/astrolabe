/**
 * Post-install: ensure better-sqlite3 has the electron-compatible binary
 * for VS Code's Electron (NODE_MODULE_VERSION 140).
 *
 * Downloads the prebuilt electron-v140 binary from better-sqlite3's
 * GitHub releases and installs it alongside the existing node binary.
 * The electron binary is cross-compatible — works with both system
 * Node.js (CLI/tests) and VS Code's Electron.
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BETTER_SQLITE3_VERSION = '12.9.0';
const ELECTRON_ABI = '140';
const PLATFORM = process.platform;
const ARCH = process.arch;

function binaryName() {
  const plat = PLATFORM === 'win32' ? 'win32' : PLATFORM === 'darwin' ? 'darwin' : 'linux';
  const arch = ARCH === 'x64' ? 'x64' : ARCH === 'arm64' ? 'arm64' : 'x64';
  return 'better-sqlite3-v' + BETTER_SQLITE3_VERSION + '-electron-v' + ELECTRON_ABI + '-' + plat + '-' + arch + '.tar.gz';
}

function binaryDest() {
  const candidates = [
    join(ROOT, 'packages', 'core', 'node_modules', 'better-sqlite3'),
    join(ROOT, 'node_modules', 'better-sqlite3'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
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
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        return;
      }
      pipeline(res, file).then(resolve, reject);
    }).on('error', reject);
  });
}

function findNode(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === 'better_sqlite3.node') return p;
    if (e.isDirectory()) {
      const r = findNode(p);
      if (r) return r;
    }
  }
  return null;
}

async function main() {
  const destDir = binaryDest();
  const buildDir = join(destDir, 'build', 'Release');
  const nodeFile = join(buildDir, 'better_sqlite3.node');

  if (existsSync(nodeFile)) {
    try {
      if (statSync(nodeFile).size > 500000) {
        console.log('[astrolabe] better-sqlite3 binary OK, skipping download.');
        return;
      }
    } catch (e) { /* re-download */ }
  }

  const name = binaryName();
  const url = 'https://github.com/WiseLibs/better-sqlite3/releases/download/v' + BETTER_SQLITE3_VERSION + '/' + name;
  const tmpDir = join(ROOT, 'node_modules', '.tmp-bs3');

  console.log('[astrolabe] Downloading electron-compatible better-sqlite3 binary...');
  console.log('[astrolabe]   ' + url);

  try {
    mkdirSync(tmpDir, { recursive: true });
    const tarball = join(tmpDir, 'bs3.tar.gz');
    await download(url, tarball);

    const result = spawnSync('tar', ['-xzf', tarball, '-C', tmpDir], { stdio: 'pipe', timeout: 30000 });
    if (result.status !== 0 && PLATFORM === 'win32') {
      spawnSync('powershell', ['-Command', "tar -xzf '" + tarball + "' -C '" + tmpDir + "'"], { stdio: 'pipe', shell: true });
    }

    const src = findNode(tmpDir);
    if (!src) throw new Error('Could not find better_sqlite3.node in extracted tarball');

    mkdirSync(buildDir, { recursive: true });
    copyFileSync(src, nodeFile);
    console.log('[astrolabe] Installed electron-v' + ELECTRON_ABI + ' binary to ' + nodeFile);
  } catch (err) {
    console.error('[astrolabe] Failed: ' + err.message);
    console.error('[astrolabe] Run "npm run postinstall" to retry.');
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ok */ }
  }
}

main();
