/**
 * Service Boundary Detector.
 *
 * Auto-detects service boundaries in monorepos by scanning for
 * manifest files and source code patterns. Identifies distinct
 * services (packages, microservices, libraries) within a repo.
 */

import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ServiceBoundary {
  /** Absolute or relative path to the service root directory. */
  servicePath: string;
  /** Derived service name (from directory or manifest). */
  serviceName: string;
  /** Manifest files found at the service root. */
  markers: string[];
  /** Confidence score 0–1 based on markers and source presence. */
  confidence: number;
  /** Detected programming languages. */
  languages: string[];
}

export interface ServiceBoundaryDetectorOptions {
  /** Root path of the repository to scan. */
  repoPath: string;
  /** Maximum directory depth to walk (default 4). */
  maxDepth?: number;
  /** Minimum confidence to include a result (default 0.5). */
  minConfidence?: number;
}

/** Simplified directory entry used internally to avoid Dirent generic issues. */
interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

// ── Manifest marker definitions ────────────────────────────────────────────

interface MarkerDef {
  filename: string;
  language: string;
  confidence: number;
  suffixMatch?: boolean;
}

const MANIFEST_MARKERS: MarkerDef[] = [
  { filename: 'package.json', language: 'javascript', confidence: 0.3 },
  { filename: 'go.mod', language: 'go', confidence: 0.3 },
  { filename: 'Cargo.toml', language: 'rust', confidence: 0.3 },
  { filename: 'pom.xml', language: 'java', confidence: 0.3 },
  { filename: 'build.gradle', language: 'java', confidence: 0.3 },
  { filename: 'pyproject.toml', language: 'python', confidence: 0.3 },
  { filename: 'setup.py', language: 'python', confidence: 0.3 },
  { filename: 'requirements.txt', language: 'python', confidence: 0.3 },
  { filename: 'Gemfile', language: 'ruby', confidence: 0.3 },
  { filename: '.csproj', language: 'csharp', confidence: 0.3, suffixMatch: true },
  { filename: 'global.json', language: 'csharp', confidence: 0.3 },
  { filename: 'composer.json', language: 'php', confidence: 0.3 },
];

/** Directories to always skip during traversal. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'vendor',
  '__pycache__',
  '.next',
  'coverage',
  '.svn',
  '.hg',
]);

/** Source file extensions that boost confidence. */
const SOURCE_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.cs': 'csharp',
  '.php': 'php',
};

// ── Detector class ─────────────────────────────────────────────────────────

export class ServiceBoundaryDetector {
  private readonly repoPath: string;
  private readonly maxDepth: number;
  private readonly minConfidence: number;

  constructor(options: ServiceBoundaryDetectorOptions) {
    this.repoPath = options.repoPath;
    this.maxDepth = options.maxDepth ?? 4;
    this.minConfidence = options.minConfidence ?? 0.5;
  }

  /** Walk directory tree and detect service boundaries. */
  async detect(): Promise<ServiceBoundary[]> {
    const results: ServiceBoundary[] = [];
    await this.walk(this.repoPath, 0, results);
    return results.filter((b) => b.confidence >= this.minConfidence);
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /** BFS walk — queues directories and scores each one. */
  private async walk(
    dirPath: string,
    depth: number,
    results: ServiceBoundary[],
  ): Promise<void> {
    if (depth > this.maxDepth) return;

    const entries = await this.readDir(dirPath);
    if (!entries) return;

    // Score this directory first
    const score = this.scoreDirectory(entries);
    if (score.markers.length > 0 && score.confidence > 0) {
      const serviceName = this.deriveServiceName(dirPath, entries);
      const languages = this.deriveLanguages(score.markers, entries);

      results.push({
        servicePath: dirPath,
        serviceName,
        markers: score.markers,
        confidence: Math.min(score.confidence, 1),
        languages,
      });
    }

    // Recurse into subdirectories (parallel for speed)
    const subdirs = entries
      .filter((e) => e.isDirectory && !SKIP_DIRS.has(e.name))
      .map((e) => join(dirPath, e.name));

    await Promise.all(
      subdirs.map((sub) => this.walk(sub, depth + 1, results)),
    );
  }

  /** Read directory and normalize to our DirEntry type. */
  private async readDir(dirPath: string): Promise<DirEntry[] | null> {
    try {
      const dirents = await readdir(dirPath, { withFileTypes: true });
      return dirents.map((d) => ({
        name: d.name,
        isFile: d.isFile(),
        isDirectory: d.isDirectory(),
      }));
    } catch {
      return null; // Permission denied or removed — skip silently
    }
  }

  /**
   * Score a directory for service boundary indicators.
   * Returns markers found, languages, and confidence score.
   */
  private scoreDirectory(
    entries: DirEntry[],
  ): { markers: string[]; languages: string[]; confidence: number } {
    const names = new Set(entries.map((e) => e.name));
    const markers: string[] = [];
    const languages: string[] = [];
    let confidence = 0;

    // 1. Check manifest markers
    for (const def of MANIFEST_MARKERS) {
      if (def.suffixMatch) {
        // .csproj is a suffix match (project-name.csproj)
        const matched = entries.find((e) => e.name.endsWith(def.filename));
        if (matched) {
          markers.push(matched.name);
          if (!languages.includes(def.language)) languages.push(def.language);
          confidence += def.confidence;
        }
      } else if (names.has(def.filename)) {
        markers.push(def.filename);
        if (!languages.includes(def.language)) languages.push(def.language);
        confidence += def.confidence;
      }
    }

    // 2. Source file presence check
    const hasSourceFiles = entries.some((e) => {
      const ext = this.extension(e.name);
      return ext in SOURCE_EXTENSIONS;
    });
    if (hasSourceFiles) {
      confidence += 0.2;
    }

    // 3. src/ or lib/ subdirectory check
    if (names.has('src') || names.has('lib')) {
      confidence += 0.1;
    }

    return { markers, languages, confidence };
  }

  /** Derive service name from directory name or manifest name field. */
  private deriveServiceName(dirPath: string, entries: DirEntry[]): string {
    const names = entries.map((e) => e.name);

    // Try package.json name field first
    if (names.includes('package.json')) {
      try {
        const pkgPath = join(dirPath, 'package.json');
        const content = readFileSync(pkgPath, 'utf-8');
        const pkg = JSON.parse(content) as { name?: string };
        if (pkg.name && typeof pkg.name === 'string' && pkg.name.trim()) {
          // Strip scope prefix (@org/pkg → pkg)
          const unscoped = pkg.name.replace(/^@[^/]+\//, '');
          if (unscoped) return unscoped;
        }
      } catch {
        // Fall through to directory name
      }
    }

    // Try Cargo.toml [package] name
    if (names.includes('Cargo.toml')) {
      try {
        const cargoPath = join(dirPath, 'Cargo.toml');
        const content = readFileSync(cargoPath, 'utf-8');
        const match = content.match(/^name\s*=\s*"([^"]+)"/m);
        if (match?.[1]) return match[1];
      } catch {
        // Fall through
      }
    }

    // Try go.mod module path
    if (names.includes('go.mod')) {
      try {
        const goModPath = join(dirPath, 'go.mod');
        const content = readFileSync(goModPath, 'utf-8');
        const match = content.match(/^module\s+(\S+)/m);
        if (match?.[1]) {
          // Take last segment of module path
          const parts = match[1].split('/');
          const last = parts[parts.length - 1];
          if (last) return last;
        }
      } catch {
        // Fall through
      }
    }

    // Fallback to directory name
    return basename(dirPath);
  }

  /** Derive full language list from markers + source file extensions. */
  private deriveLanguages(markers: string[], entries: DirEntry[]): string[] {
    const langSet = new Set<string>();

    // Languages from markers
    for (const marker of markers) {
      const def = MANIFEST_MARKERS.find((m) => {
        if (m.suffixMatch) return marker.endsWith(m.filename);
        return m.filename === marker;
      });
      if (def) langSet.add(def.language);
    }

    // Languages from source file extensions
    for (const entry of entries) {
      const ext = this.extension(entry.name);
      const lang = SOURCE_EXTENSIONS[ext];
      if (lang) langSet.add(lang);
    }

    return Array.from(langSet);
  }

  /** Get the file extension including the dot. */
  private extension(filename: string): string {
    const dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.slice(dot) : '';
  }
}

// ── Standalone helper for groups integration ───────────────────────────────

/**
 * Auto-detect service boundaries in a repository.
 * Convenience wrapper around ServiceBoundaryDetector.
 */
export async function autoDetectGroups(
  repoPath: string,
): Promise<ServiceBoundary[]> {
  const detector = new ServiceBoundaryDetector({ repoPath });
  return detector.detect();
}
