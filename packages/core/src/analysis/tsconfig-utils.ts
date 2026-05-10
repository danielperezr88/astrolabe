/**
 * tsconfig-utils — parse tsconfig.json path aliases for TypeScript import resolution.
 *
 * Reads compilerOptions.paths and compilerOptions.baseUrl from tsconfig.json
 * and returns a Map of alias prefix → target path prefix for use during
 * import resolution.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

/** A single parsed alias entry ready for prefix matching. */
export interface AliasEntry {
  /** The prefix to match against import specifiers (e.g. "@/" or "@lib"). */
  prefix: string;
  /** The target path prefix to replace with (e.g. "src/" or "src/lib/index"). */
  target: string;
  /** Whether this entry uses `*` wildcard matching (true) or exact match (false). */
  wildcard: boolean;
}

/** Parsed tsconfig paths + baseUrl. */
export interface TsconfigPaths {
  /** Ordered list of alias entries (first match wins). */
  aliases: AliasEntry[];
  /** compilerOptions.baseUrl, or null if not set. */
  baseUrl: string | null;
}

// ── Cache ──────────────────────────────────────────────────────────────────

const aliasCache = new Map<string, TsconfigPaths>();

/**
 * Clear the cached tsconfig alias data for all repos.
 * Useful in tests to ensure fresh state.
 */
export function clearTsconfigCache(): void {
  aliasCache.clear();
}

// ── Parser ─────────────────────────────────────────────────────────────────

/**
 * Read tsconfig.json from the repo root and extract path aliases + baseUrl.
 *
 * Handles:
 * - Wildcard aliases: `"@/*": ["src/*"]` → prefix "@/" → target "src/"
 * - Exact aliases:    `"@lib": ["src/lib"]` → prefix "@lib" → target "src/lib"
 * - Aliases with extension: `"@lib": ["src/lib/index.ts"]` → extension stripped
 * - compoundPathKeyPaths (array of backup paths): only the first target is used
 * - compilerOptions.baseUrl for context
 *
 * Results are cached per repoPath. Call clearTsconfigCache() to invalidate.
 *
 * @param repoPath - Absolute path to the repository root.
 * @returns Parsed paths, or empty aliases if tsconfig.json doesn't exist.
 */
export function loadTsconfigAliases(repoPath: string): TsconfigPaths {
  const cached = aliasCache.get(repoPath);
  if (cached) return cached;

  const result = parseTsconfigFile(repoPath);
  aliasCache.set(repoPath, result);
  return result;
}

/**
 * Internal parse implementation (no caching).
 * Separated so tests can call it directly without cache interference.
 */
export function parseTsconfigFile(repoPath: string): TsconfigPaths {
  const tsconfigPath = join(repoPath, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return { aliases: [], baseUrl: null };
  }

  let raw: Record<string, unknown>;
  try {
    const content = readFileSync(tsconfigPath, 'utf-8');
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // Malformed JSON — return empty
    return { aliases: [], baseUrl: null };
  }

  const compilerOptions = raw.compilerOptions as Record<string, unknown> | undefined;
  if (!compilerOptions) {
    return { aliases: [], baseUrl: null };
  }

  const baseUrl = typeof compilerOptions.baseUrl === 'string'
    ? compilerOptions.baseUrl
    : null;

  const paths = compilerOptions.paths as Record<string, string[]> | undefined;
  if (!paths || typeof paths !== 'object') {
    return { aliases: [], baseUrl };
  }

  const aliases: AliasEntry[] = [];

  for (const [aliasKey, targetArr] of Object.entries(paths)) {
    if (!Array.isArray(targetArr) || targetArr.length === 0) continue;

    // Only use the first target path (TypeScript falls through to subsequent
    // entries, but for our resolution purposes the first is authoritative)
    let target = targetArr[0];

    // Normalize: strip leading ./ from target paths
    if (target.startsWith('./')) {
      target = target.slice(2);
    }

    // Handle wildcard alias:  "@/*" → prefix "@/"  or  "@components/*" → prefix "@components/"
    // Wildcard target:        "src/*" → target "src/"
    const aliasHasStar = aliasKey.includes('*');
    const targetHasStar = target.includes('*');

    if (aliasHasStar) {
      // Extract prefix (everything before the first `*`)
      const aliasPrefix = aliasKey.substring(0, aliasKey.indexOf('*'));

      let targetPrefix: string;
      if (targetHasStar) {
        targetPrefix = target.substring(0, target.indexOf('*'));
      } else {
        // Alias has wildcard but target doesn't — unexpected but valid.
        // Treat as exact replacement.
        targetPrefix = target;
      }

      aliases.push({
        prefix: aliasPrefix,
        target: targetPrefix,
        wildcard: true,
      });
    } else {
      // Exact alias: "@lib" → "src/lib"
      let normalizedTarget = target;
      // Strip file extension for consistent matching
      normalizedTarget = normalizedTarget.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');

      aliases.push({
        prefix: aliasKey,
        target: normalizedTarget,
        wildcard: false,
      });
    }
  }

  return { aliases, baseUrl };
}

/**
 * Resolve an import specifier using tsconfig path aliases.
 *
 * @param importSpec - The bare import specifier (e.g. "@/components/Button").
 * @param tsconfigPaths - Parsed tsconfig paths from loadTsconfigAliases().
 * @returns The resolved file path (relative to repo root), or the original
 *          importSpec if no alias matches.
 */
export function resolveAliasImport(
  importSpec: string,
  tsconfigPaths: TsconfigPaths,
): string {
  for (const alias of tsconfigPaths.aliases) {
    if (alias.wildcard) {
      if (importSpec.startsWith(alias.prefix)) {
        const rest = importSpec.slice(alias.prefix.length);
        // Strip extension from the resolved part if present
        const cleaned = rest.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
        return alias.target + cleaned;
      }
    } else {
      if (importSpec === alias.prefix) {
        return alias.target;
      }
    }
  }

  // No alias matched — return as-is
  return importSpec;
}
