#!/usr/bin/env node
/**
 * benchmark.mjs — Run the analysis pipeline against a repo and collect metrics.
 *
 * Usage:
 *   node scripts/benchmark.mjs                             # Default: packages/shared
 *   node scripts/benchmark.mjs --repo /path/to/repo        # Custom repo path
 *   node scripts/benchmark.mjs --repo packages/core --json  # JSON-only output
 *
 * The script runs `astrolabe analyze --profile` against the target repo,
 * captures the structured timing output from stderr, and prints a JSON
 * summary with per-phase breakdown, memory usage, and graph stats.
 *
 * Output schema:
 *   {
 *     version: string,        // CLI package version
 *     timestamp: string,      // ISO 8601
 *     phases: { name: ms },   // Per-phase duration in ms
 *     totalMs: number,        // Pipeline timing total
 *     wallClockMs: number,    // Real wall-clock time
 *     memory: { before, after, delta },
 *     nodeCount: number,
 *     edgeCount: number,
 *     cli: { command, entry }
 *   }
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_REPO = join(repoRoot, 'packages', 'shared');
const CLI_ENTRY = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const NPM_ENTRY = 'astrolabe';

// ── Helpers ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let repo = DEFAULT_REPO;
  let jsonOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && i + 1 < args.length) {
      repo = resolve(repoRoot, args[++i]);
    } else if (args[i] === '--json') {
      jsonOnly = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node scripts/benchmark.mjs [options]

Options:
  --repo <path>   Path to the repository to analyze (default: packages/shared)
  --json          Only output the JSON result (no progress messages to stderr)
  --help, -h      Show this help message
      `);
      process.exit(0);
    }
  }

  return { repo, jsonOnly };
}

function resolveCli() {
  // Prefer the built CLI dist, fall back to npx astrolabe
  if (existsSync(CLI_ENTRY)) {
    return { cmd: 'node', cliArgs: [CLI_ENTRY] };
  }
  // Try npx as fallback
  return { cmd: 'npx', cliArgs: [NPM_ENTRY] };
}

function formatBytes(bytes) {
  if (bytes == null) return 'N/A';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseProfileOutput(stderr) {
  const startMarker = '---ASTROLABE_PROFILE_START---';
  const endMarker = '---ASTROLABE_PROFILE_END---';

  const startIdx = stderr.indexOf(startMarker);
  const endIdx = stderr.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const jsonStr = stderr.substring(startIdx + startMarker.length, endIdx).trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function buildOutput(profileData, wallClockMs, cmd, entry) {
  const base = {
    version: profileData?.version ?? 'unknown',
    timestamp: profileData?.timestamp ?? new Date().toISOString(),
    phases: profileData?.phases ?? {},
    totalMs: profileData?.totalMs ?? 0,
    wallClockMs,
    memory: null,
    nodeCount: profileData?.nodeCount ?? 0,
    edgeCount: profileData?.edgeCount ?? 0,
    cli: { command: cmd, entry },
  };

  // Format memory with human-readable + raw bytes for programmatic consumers
  if (profileData?.memory) {
    const m = profileData.memory;
    base.memory = {
      before: {
        rss: formatBytes(m.before.rss),
        heapUsed: formatBytes(m.before.heapUsed),
        heapTotal: formatBytes(m.before.heapTotal),
        external: formatBytes(m.before.external),
      },
      after: {
        rss: formatBytes(m.after.rss),
        heapUsed: formatBytes(m.after.heapUsed),
        heapTotal: formatBytes(m.after.heapTotal),
        external: formatBytes(m.after.external),
      },
      delta: {
        rss: formatBytes(m.after.rss - m.before.rss),
        heapUsed: formatBytes(m.after.heapUsed - m.before.heapUsed),
      },
    };
    base.memoryRaw = m;
  }

  if (profileData?.error) {
    base.error = profileData.error;
  }

  return base;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const { repo, jsonOnly } = parseArgs();

  // Validate repo path
  if (!existsSync(repo)) {
    console.error(`Error: repo path does not exist: ${repo}`);
    process.exit(1);
  }
  if (!statSync(repo).isDirectory()) {
    console.error(`Error: repo path is not a directory: ${repo}`);
    process.exit(1);
  }

  const { cmd, cliArgs } = resolveCli();
  const analyzeArgs = [...cliArgs, 'analyze', repo, '--profile', '--log-level', 'error'];

  if (!jsonOnly) {
    console.error(`Benchmarking analysis against: ${repo}`);
    console.error(`Command: ${cmd} ${analyzeArgs.join(' ')}`);
    console.error('Running analysis...');
  }

  const startTime = Date.now();

  // Use spawnSync to capture stdout and stderr separately
  const result = spawnSync(cmd, analyzeArgs, {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 300000, // 5 minutes max
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const wallClockMs = Date.now() - startTime;
  const stderr = result.stderr || '';
  const profileData = parseProfileOutput(stderr);

  const output = buildOutput(profileData, wallClockMs, cmd, cliArgs.join(' '));

  if (!profileData) {
    // Include diagnostics in output on failure
    output.error = output.error || 'Could not parse profile output from stderr';
    output.stderrSnippet = stderr.slice(-2000);
    output.status = result.status;
    process.exitCode = 1;
  }

  console.log(JSON.stringify(output, null, 2));
}

main();
