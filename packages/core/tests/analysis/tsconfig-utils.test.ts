/**
 * Tests for tsconfig-utils — tsconfig.json path alias parsing.
 *
 * Exercises parseTsconfigFile, loadTsconfigAliases, resolveAliasImport,
 * and the per-repo cache behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseTsconfigFile,
  loadTsconfigAliases,
  resolveAliasImport,
  clearTsconfigCache,
} from '../../src/analysis/tsconfig-utils.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temporary repo directory with an optional tsconfig.json. */
function makeRepo(tsconfig?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'astrolabe-tsconfig-'));
  if (tsconfig) {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  }
  return dir;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('tsconfig-utils', () => {
  let repoDir: string;

  beforeEach(() => {
    clearTsconfigCache();
  });

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ── parseTsconfigFile ──────────────────────────────────────────────────────

  describe('parseTsconfigFile', () => {
    it('returns empty aliases when tsconfig.json does not exist', () => {
      repoDir = mkdtempSync(join(tmpdir(), 'no-tsconfig-'));
      const result = parseTsconfigFile(repoDir);
      expect(result.aliases).toEqual([]);
      expect(result.baseUrl).toBeNull();
    });

    it('returns empty aliases when tsconfig.json has no compilerOptions', () => {
      repoDir = makeRepo({});
      const result = parseTsconfigFile(repoDir);
      expect(result.aliases).toEqual([]);
      expect(result.baseUrl).toBeNull();
    });

    it('returns empty aliases when tsconfig has no paths', () => {
      repoDir = makeRepo({
        compilerOptions: { target: 'ES2022' },
      });
      const result = parseTsconfigFile(repoDir);
      expect(result.aliases).toEqual([]);
      expect(result.baseUrl).toBeNull();
    });

    it('returns empty aliases for malformed JSON', () => {
      repoDir = mkdtempSync(join(tmpdir(), 'bad-json-'));
      writeFileSync(join(repoDir, 'tsconfig.json'), 'not-json{');
      const result = parseTsconfigFile(repoDir);
      expect(result.aliases).toEqual([]);
      expect(result.baseUrl).toBeNull();
    });

    it('parses baseUrl from compilerOptions', () => {
      repoDir = makeRepo({
        compilerOptions: {
          baseUrl: 'src',
        },
      });
      const result = parseTsconfigFile(repoDir);
      expect(result.baseUrl).toBe('src');
      expect(result.aliases).toEqual([]);
    });

    it('parses a single wildcard alias @/* → src/*', () => {
      repoDir = makeRepo({
        compilerOptions: {
          paths: {
            '@/*': ['src/*'],
          },
        },
      });
      const result = parseTsconfigFile(repoDir);
      expect(result.aliases).toHaveLength(1);
      expect(result.aliases[0]).toEqual({
        prefix: '@/*'.substring(0, '@/*'.indexOf('*')),
        target: 'src/',
        wildcard: true,
      });
    });

    it('parses multiple wildcard aliases', () => {
      repoDir = makeRepo({
        compilerOptions: {
          paths: {
            '@/*': ['src/*'],
            '@components/*': ['src/components/*'],
            '@lib/*': ['src/lib/*'],
          },
        },
      });
      const result = parseTsconfigFile(repoDir);
      expect(result.aliases).toHaveLength(3);
      expect(result.aliases[0].prefix).toBe('@/');
      expect(result.aliases[0].target).toBe('src/');
      expect(result.aliases[1].prefix).toBe('@components/');
      expect(result.aliases[1].target).toBe('src/components/');
      expect(result.aliases[2].prefix).toBe('@lib/');
      expect(result.aliases[2].target).toBe('src/lib/');
    });

    it('parses exact (non-wildcard) aliases', () => {
      repoDir = makeRepo({
        compilerOptions: {
          paths: {
            '@lib': ['src/lib/index.ts'],
            '@utils': ['src/utils/index'],
          },
        },
      });
      const result = parseTsconfigFile(repoDir);
      expect(result.aliases).toHaveLength(2);
      // Exact aliases strip extension from target
      expect(result.aliases[0]).toEqual({
        prefix: '@lib',
        target: 'src/lib/index',
        wildcard: false,
      });
      expect(result.aliases[1]).toEqual({
        prefix: '@utils',
        target: 'src/utils/index',
        wildcard: false,
      });
    });

    it('ignores empty path target arrays', () => {
      repoDir = makeRepo({
        compilerOptions: {
          paths: {
            '@/*': [],
          },
        },
      });
      const result = parseTsconfigFile(repoDir);
      expect(result.aliases).toEqual([]);
    });

    it('uses first target path when array has multiple entries', () => {
      repoDir = makeRepo({
        compilerOptions: {
          paths: {
            '@/*': ['src/*', 'dist/*'],
          },
        },
      });
      const result = parseTsconfigFile(repoDir);
      expect(result.aliases).toHaveLength(1);
      expect(result.aliases[0].target).toBe('src/');
    });

    it('handles wildcard alias where target has no wildcard', () => {
      repoDir = makeRepo({
        compilerOptions: {
          paths: {
            '@constants': ['src/constants.ts'],
          },
        },
      });
      const result = parseTsconfigFile(repoDir);
      expect(result.aliases).toHaveLength(1);
      expect(result.aliases[0].wildcard).toBe(false);
      expect(result.aliases[0].target).toBe('src/constants');
    });

    it('strips leading ./ from target paths', () => {
      repoDir = makeRepo({
        compilerOptions: {
          paths: {
            '@/*': ['./src/*'],
          },
        },
      });
      const result = parseTsconfigFile(repoDir);
      expect(result.aliases[0].target).toBe('src/');
    });

    it('parses both baseUrl and paths together', () => {
      repoDir = makeRepo({
        compilerOptions: {
          baseUrl: 'src',
          paths: {
            '@/*': ['./*'],
          },
        },
      });
      const result = parseTsconfigFile(repoDir);
      expect(result.baseUrl).toBe('src');
      expect(result.aliases).toHaveLength(1);
      expect(result.aliases[0].target).toBe('');
      expect(result.aliases[0].prefix).toBe('@/');
    });
  });

  // ── resolveAliasImport ─────────────────────────────────────────────────────

  describe('resolveAliasImport', () => {
    it('resolves a wildcard alias import', () => {
      const paths = {
        aliases: [{ prefix: '@/', target: 'src/', wildcard: true }],
        baseUrl: null,
      };
      expect(resolveAliasImport('@/components/Button', paths)).toBe('src/components/Button');
    });

    it('resolves a deeply nested wildcard alias import', () => {
      const paths = {
        aliases: [{ prefix: '@/', target: 'src/', wildcard: true }],
        baseUrl: null,
      };
      expect(resolveAliasImport('@/components/sub/Button', paths)).toBe('src/components/sub/Button');
    });

    it('resolves an exact alias import', () => {
      const paths = {
        aliases: [{ prefix: '@lib', target: 'src/lib/index', wildcard: false }],
        baseUrl: null,
      };
      expect(resolveAliasImport('@lib', paths)).toBe('src/lib/index');
    });

    it('returns original import when no alias matches', () => {
      const paths = {
        aliases: [{ prefix: '@/', target: 'src/', wildcard: true }],
        baseUrl: null,
      };
      expect(resolveAliasImport('lodash', paths)).toBe('lodash');
    });

    it('returns original import when path has no matching prefix', () => {
      const paths = {
        aliases: [{ prefix: '@lib/', target: 'src/lib/', wildcard: true }],
        baseUrl: null,
      };
      expect(resolveAliasImport('@components/Button', paths)).toBe('@components/Button');
    });

    it('resolves first matching alias from multiple entries', () => {
      const paths = {
        aliases: [
          { prefix: '@/', target: 'src/', wildcard: true },
          { prefix: '@components/', target: 'src/components/', wildcard: true },
        ],
        baseUrl: null,
      };
      expect(resolveAliasImport('@/components/Button', paths)).toBe('src/components/Button');
      expect(resolveAliasImport('@components/Button', paths)).toBe('src/components/Button');
    });

    it('strips file extension from alias-resolved paths', () => {
      const paths = {
        aliases: [{ prefix: '@/', target: 'src/', wildcard: true }],
        baseUrl: null,
      };
      expect(resolveAliasImport('@/utils/helper.ts', paths)).toBe('src/utils/helper');
    });

    it('handles empty aliases array gracefully', () => {
      const paths = { aliases: [], baseUrl: null };
      expect(resolveAliasImport('@/components/Button', paths)).toBe('@/components/Button');
    });
  });

  // ── loadTsconfigAliases (caching) ──────────────────────────────────────────

  describe('loadTsconfigAliases', () => {
    it('loads and caches aliases from a real tsconfig.json', () => {
      repoDir = makeRepo({
        compilerOptions: {
          paths: {
            '@/*': ['src/*'],
          },
        },
      });
      const result = loadTsconfigAliases(repoDir);
      expect(result.aliases).toHaveLength(1);
      expect(result.aliases[0].prefix).toBe('@/');
      expect(result.aliases[0].target).toBe('src/');
    });

    it('returns empty aliases when no tsconfig.json exists', () => {
      repoDir = mkdtempSync(join(tmpdir(), 'no-tsconfig-'));
      const result = loadTsconfigAliases(repoDir);
      expect(result.aliases).toEqual([]);
      expect(result.baseUrl).toBeNull();
    });

    it('caches results and returns same object for same repoPath', () => {
      repoDir = makeRepo({
        compilerOptions: {
          paths: {
            '@/*': ['src/*'],
          },
        },
      });
      const first = loadTsconfigAliases(repoDir);
      const second = loadTsconfigAliases(repoDir);
      expect(first).toBe(second); // Same reference from cache
    });

    it('returns fresh results after cache is cleared', () => {
      repoDir = makeRepo({
        compilerOptions: {
          paths: {
            '@/*': ['src/*'],
          },
        },
      });
      const first = loadTsconfigAliases(repoDir);
      clearTsconfigCache();
      const second = loadTsconfigAliases(repoDir);
      expect(first).not.toBe(second); // Different reference
    });
  });
});
