/**
 * Pipeline Phase: Scan
 *
 * Discovers all source files in the repository, respecting a .astrolabeignore
 * file (same syntax as .gitignore). Computes SHA256 content hashes and detects
 * programming languages by file extension.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import type { SupportedLanguage } from '../../core/types.js';
import { languageForExtension } from '../parser.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** A single discovered file entry. */
export interface FileEntry {
  /** Repo-relative path (forward slashes, no leading ./). */
  path: string;
  /** Absolute filesystem path. */
  absolutePath: string;
  /** File size in bytes. */
  size: number;
  /** SHA256 hex digest of file contents. */
  hash: string;
  /** File extension with leading dot (e.g. ".ts"). */
  extension: string;
  /** Detected programming language, or null if unsupported. */
  language: SupportedLanguage | null;
}

/** Output produced by the scan phase. */
export interface ScanOutput {
  files: FileEntry[];
}

// ── Default ignore patterns ─────────────────────────────────────────────────

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '__pycache__',
  '*.tsbuildinfo',
  '.DS_Store',
  'Thumbs.db',
  '*.wasm',
  '*.map',
  '*.lock',
  'coverage',
  '.nyc_output',
  '.astro',
];

// ── .astrolabeignore parser ─────────────────────────────────────────────────

/**
 * Parse a .astrolabeignore file into an array of regex patterns.
 *
 * Supports the same syntax as .gitignore:
 * - Lines starting with `#` are comments.
 * - Blank lines are ignored.
 * - Lines ending with `/` match directories only.
 * - Leading `!` negates a previous pattern (not implemented — repo is small).
 * - Leading `/` anchors to repo root (default behaviour for relative patterns).
 */
function parseIgnoreFile(content: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (let line of content.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // Skip negation for now

    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (line.startsWith('/')) line = line.slice(1);

    // Convert gitignore glob to regex
    const regexStr = globToRegex(line, dirOnly);
    patterns.push(new RegExp(regexStr));
  }
  return patterns;
}

/**
 * Convert a simple gitignore-style glob to a regex string.
 * Handles `*` (any non-slash chars), `**` (any chars including slash), and `?`.
 */
function globToRegex(glob: string, dirOnly: boolean): string {
  let re = '';
  let i = 0;

  while (i < glob.length) {
    const ch = glob[i];

    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // ** — any chars including /
        i += 2;
        if (glob[i] === '/') i++; // **/ — match any path prefix
        re += '.*';
      } else {
        // * — any non-slash chars
        i++;
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '.') {
      re += '\\.';
      i++;
    } else {
      re += ch;
      i++;
    }
  }

  if (dirOnly) {
    re += '(?:/.*)?$';
  } else {
    re += '$';
  }

  return `^(?:.*/)?${re}`;
}

/** Build the combined ignore regex list from file + defaults. */
function buildIgnorePatterns(repoPath: string): RegExp[] {
  const patterns: RegExp[] = DEFAULT_IGNORE.map((g) => new RegExp(globToRegex(g, false)));

  const ignoreFile = join(repoPath, '.astrolabeignore');
  if (existsSync(ignoreFile)) {
    const content = readFileSync(ignoreFile, 'utf-8');
    patterns.push(...parseIgnoreFile(content));
  }

  return patterns;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Check if a path should be ignored based on patterns. */
function isIgnored(relPath: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(relPath));
}

/** Compute SHA256 hash of file contents. */
function computeHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/** Recursively discover source files. */
function discoverFiles(
  dirPath: string,
  repoPath: string,
  patterns: RegExp[],
  files: FileEntry[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return; // Skip unreadable directories
  }

  for (const entry of entries) {
    const fullPath = resolve(dirPath, entry);
    const relPath = relative(repoPath, fullPath).replace(/\\/g, '/');

    if (isIgnored(relPath, patterns)) continue;

    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      discoverFiles(fullPath, repoPath, patterns, files);
    } else if (st.isFile()) {
      const ext = extname(entry).toLowerCase();
      const langDef = languageForExtension(ext);
      const language = langDef ? langDef.name : null;
      const hash = computeHash(fullPath);
      files.push({
        path: relPath,
        absolutePath: fullPath,
        size: st.size,
        hash,
        extension: ext || '',
        language,
      });
    }
  }
}

// ── Phase definition ────────────────────────────────────────────────────────

/** Scan phase — discovers all source files and computes their hashes. */
export const scanPhase: PhaseDefinition<ScanOutput> = {
  name: 'scan',
  dependencies: [],

  execute(context: PhaseContext): ScanOutput {
    const patterns = buildIgnorePatterns(context.repoPath);
    const files: FileEntry[] = [];

    discoverFiles(context.repoPath, context.repoPath, patterns, files);

    // Sort by path for determinism
    files.sort((a, b) => a.path.localeCompare(b.path));

    return { files };
  },
};
