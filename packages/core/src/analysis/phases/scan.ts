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
import { languageForExtension, getAllExtensions } from '../parser.js';

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
  'vendor',
  '.venv',
  'venv',
  'target',
  'bin',
  'obj',
];

/** Extensions to skip regardless of language support (binary, media, fonts). */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.bmp', '.webp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.webm', '.ogg', '.wav', '.flac',
  '.db', '.sqlite', '.sqlite3',
]);

/** Max file size in bytes to scan (512 KB default). Overridable via env or context. */
const DEFAULT_MAX_FILE_SIZE = 512 * 1024;
const MAX_FILE_SIZE_CAP = 32 * 1024 * 1024; // 32 MB — tree-sitter parser ceiling

function getMaxFileSize(context: PhaseContext): number {
  // Env override
  const envVal = process.env.ASTROLABE_MAX_FILE_SIZE;
  if (envVal) {
    const kib = parseInt(envVal, 10);
    if (!isNaN(kib) && kib > 0) return Math.min(kib * 1024, MAX_FILE_SIZE_CAP);
  }
  // Context option override
  const ctxVal = context.state.get('options:maxFileSize') as number | undefined;
  if (ctxVal !== undefined && ctxVal > 0) return Math.min(ctxVal * 1024, MAX_FILE_SIZE_CAP);
  return DEFAULT_MAX_FILE_SIZE;
}

/** Config/metadata extensions to include even without a language provider. */
const CONFIG_EXTENSIONS = new Set([
  '.md', '.mdx', '.json', '.yaml', '.yml', '.toml', '.xml',
  '.env', '.cfg', '.ini', '.conf', '.mod', '.sum', '.txt',
  '.css', '.scss', '.html', '.sql', '.graphql', '.proto', '.prisma',
]);

/** Allowed extensions derived from language registry + config (#115). */
let _allowedExtensions: Set<string> | undefined;
function getAllowedExtensions(): Set<string> {
  if (_allowedExtensions) return _allowedExtensions;
  _allowedExtensions = new Set(CONFIG_EXTENSIONS);
  for (const ext of getAllExtensions()) _allowedExtensions.add(ext);
  return _allowedExtensions;
}

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
  maxFileSize: number,
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
      discoverFiles(fullPath, repoPath, patterns, files, maxFileSize);
    } else if (st.isFile()) {
      // Skip binary files by extension (#77)
      const ext = extname(entry).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;
      // Skip files without known code extensions (if they also have no recognized language)
      const langDef = languageForExtension(ext);
      const language = langDef ? langDef.name : null;
      // Skip if neither a code extension nor a recognized config extension (#115)
      if (!langDef && !getAllowedExtensions().has(ext)) continue;
      // Skip large files (#77) — threshold configurable via --max-file-size or ASTROLABE_MAX_FILE_SIZE
      if (st.size > maxFileSize) continue;
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
    const maxFileSize = getMaxFileSize(context);

    discoverFiles(context.repoPath, context.repoPath, patterns, files, maxFileSize);

    // Sort by path for determinism
    files.sort((a, b) => a.path.localeCompare(b.path));

    return { files };
  },
};
