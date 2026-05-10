#!/usr/bin/env node

/**
 * Post-install grammar verifier & builder.
 *
 * Checks that all required tree-sitter WASM grammar files exist in the
 * `packages/core/wasm/` directory. For any that are missing, attempts to
 * build them from source using the tree-sitter CLI (if available).
 *
 * **ALWAYS exits 0** — warnings only, never blocks `npm install`.
 *
 * Skip entirely by setting:
 *   ASTROLABE_SKIP_GRAMMAR_BUILD=1
 *
 * This script is idempotent: safe to run multiple times.
 */

import { existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

// ── Grammar registry ──────────────────────────────────────────────────────
//
// Every language supported by Astrolabe and its corresponding WASM file.
// Matches the definitions in packages/core/src/analysis/languages/*.ts.
// The `extraFiles` entries are secondary grammars loaded alongside the
// primary one (e.g. tree-sitter-tsx.wasm for the TypeScript grammar).

const GRAMMARS = [
  { name: 'javascript',  file: 'tree-sitter-javascript.wasm',     npm: 'tree-sitter-javascript' },
  { name: 'typescript',  file: 'tree-sitter-typescript.wasm',     npm: 'tree-sitter-typescript', extraFiles: ['tree-sitter-tsx.wasm'] },
  { name: 'tsx',         file: 'tree-sitter-tsx.wasm',            npm: 'tree-sitter-tsx' },
  { name: 'python',      file: 'tree-sitter-python.wasm',         npm: 'tree-sitter-python' },
  { name: 'go',          file: 'tree-sitter-go.wasm',             npm: 'tree-sitter-go' },
  { name: 'rust',        file: 'tree-sitter-rust.wasm',           npm: 'tree-sitter-rust' },
  { name: 'java',        file: 'tree-sitter-java.wasm',           npm: 'tree-sitter-java' },
  { name: 'kotlin',      file: 'tree-sitter-kotlin.wasm',         npm: 'tree-sitter-kotlin' },
  { name: 'csharp',      file: 'tree-sitter-c-sharp.wasm',        npm: 'tree-sitter-c-sharp' },
  { name: 'php',         file: 'tree-sitter-php.wasm',            npm: 'tree-sitter-php' },
  { name: 'ruby',        file: 'tree-sitter-ruby.wasm',           npm: 'tree-sitter-ruby' },
  { name: 'swift',       file: 'tree-sitter-swift.wasm',          npm: 'tree-sitter-swift' },
  { name: 'c',           file: 'tree-sitter-c.wasm',              npm: 'tree-sitter-c' },
  { name: 'cpp',         file: 'tree-sitter-cpp.wasm',            npm: 'tree-sitter-cpp' },
  { name: 'protobuf',    file: 'tree-sitter-proto.wasm',          npm: 'tree-sitter-proto' },
];

const WASM_DIR = resolve(ROOT, 'packages', 'core', 'wasm');

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Check if a WASM file exists and looks valid (>1 KB to avoid empty/stub files). */
function wasmValid(filePath) {
  if (!existsSync(filePath)) return false;
  try {
    return statSync(filePath).size > 1024;
  } catch { return false; }
}

/** Find the grammar source directory inside node_modules. */
function findGrammarSource(npmPackage) {
  const candidates = [
    resolve(ROOT, 'node_modules', npmPackage),
    resolve(ROOT, 'packages', 'core', 'node_modules', npmPackage),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Check if the tree-sitter CLI is available (either globally or via npx).
 * Returns 'cli' if a global/npm install exists, 'npx' if npx can fetch it, null otherwise.
 */
function detectTreeSitterCli() {
  // Check for global tree-sitter install
  const which = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    ['tree-sitter'],
    { stdio: 'pipe', shell: true }
  );
  if (which.status === 0 && which.stdout.toString().trim().length > 0) {
    return 'cli';
  }

  // Check if tree-sitter is installed in node_modules
  const local = resolve(ROOT, 'node_modules', '.bin', 'tree-sitter');
  const localAlt = resolve(ROOT, 'node_modules', 'tree-sitter', 'cli.js');
  if (existsSync(local) || existsSync(localAlt)) {
    return 'cli';
  }

  // Check if npx is available (can fetch on demand)
  const npxCheck = spawnSync('npx', ['--version'], { stdio: 'pipe', shell: true });
  if (npxCheck.status === 0) {
    return 'npx';
  }

  return null;
}

/**
 * Attempt to build a grammar WASM file from its npm source package.
 *
 * Uses the tree-sitter CLI: `tree-sitter build --wasm -o <output> <source-dir>`.
 *
 * @param {object} grammar - Grammar descriptor from GRAMMARS array.
 * @returns {boolean} true if the build succeeded and the output file exists.
 */
function buildGrammar(grammar) {
  const srcDir = findGrammarSource(grammar.npm);
  if (!srcDir) {
    console.error(`    ⚠ Grammar source not found — install ${grammar.npm} and retry`);
    return false;
  }

  const wasmPath = resolve(WASM_DIR, grammar.file);
  const cliType = detectTreeSitterCli();
  if (!cliType) {
    console.error(`    ⚠ tree-sitter CLI not found — install it globally to enable grammar builds`);
    return false;
  }

  const args = cliType === 'npx'
    ? ['--yes', 'tree-sitter', 'build', '--wasm', '-o', wasmPath, srcDir]
    : ['tree-sitter', 'build', '--wasm', '-o', wasmPath, srcDir];

  console.log(`    Building ${grammar.file} from ${grammar.npm}...`);
  const result = spawnSync(cliType === 'npx' ? 'npx' : 'tree-sitter', args, {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 180000, // 3 minutes per grammar
    shell: true,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || '';
    console.error(`    ⚠ Build failed: ${stderr.slice(0, 500)}`);
    return false;
  }

  if (!wasmValid(wasmPath)) {
    console.error(`    ⚠ Build completed but output file is missing or invalid`);
    return false;
  }

  return true;
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Verify all tree-sitter WASM grammars, attempting to build any that are missing.
 *
 * Designed to be called both as a standalone script and imported from
 * scripts/postinstall.mjs. Always exits gracefully — never throws.
 */
export default async function main() {
  // Allow skipping entirely
  if (process.env.ASTROLABE_SKIP_GRAMMAR_BUILD) {
    console.log('[astrolabe] ASTROLABE_SKIP_GRAMMAR_BUILD=1 — skipping grammar check');
    return;
  }

  console.log('[astrolabe] Checking tree-sitter WASM grammars...');

  // Ensure WASM directory exists
  if (!existsSync(WASM_DIR)) {
    mkdirSync(WASM_DIR, { recursive: true });
  }

  let present = 0;
  let missing = 0;
  let built = 0;
  let failed = 0;

  for (const grammar of GRAMMARS) {
    const wasmPath = resolve(WASM_DIR, grammar.file);

    if (wasmValid(wasmPath)) {
      const size = statSync(wasmPath).size;
      console.log(`  ✓ ${grammar.file} (${(size / 1024).toFixed(1)} KB)`);
      present++;
      continue;
    }

    // Grammar is missing — attempt to build
    missing++;
    console.log(`  … ${grammar.file} — missing, attempting build...`);

    if (buildGrammar(grammar)) {
      built++;
      const size = statSync(wasmPath).size;
      console.log(`    ✓ Built ${grammar.file} (${(size / 1024).toFixed(1)} KB)`);
    } else {
      failed++;
    }

    // Check extra files (e.g. tsx for typescript)
    if (grammar.extraFiles) {
      for (const extraFile of grammar.extraFiles) {
        const extraPath = resolve(WASM_DIR, extraFile);
        if (!wasmValid(extraPath)) {
          console.log(`  ⚠ ${extraFile} (extra for ${grammar.name}) — missing, will be resolved at runtime`);
        }
      }
    }
  }

  const total = GRAMMARS.length;
  const available = present + built;
  console.log(`\n[astrolabe] Grammars: ${available}/${total} available (${built} built, ${failed} failed)`);

  if (failed > 0) {
    console.log('[astrolabe] ⚠ Some grammars could not be built — runtime fallback will apply');
  }
}

// ── Self-execution when run as a standalone script ───────────────────────────
// When imported from postinstall.mjs, postinstall handles the lifecycle.
const isMain = process.argv[1] && (
  process.argv[1] === __filename ||
  process.argv[1].endsWith('/build-grammars.mjs') ||
  process.argv[1].endsWith('\\build-grammars.mjs')
);

if (isMain) {
  main().catch((err) => {
    console.error('[astrolabe] Grammar check error:', err.message);
    // NEVER block install — always exit 0
  }).finally(() => {
    process.exit(0);
  });
}
