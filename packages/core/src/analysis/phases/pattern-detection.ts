/**
 * Pipeline Phase: Pattern Detection (#872 Phase 2).
 *
 * Runs tree-sitter pattern detection queries against parsed source files
 * from the AST tree cache. Creates `PatternInstance` nodes and
 * `IMPLEMENTS_PATTERN` edges in the knowledge graph.
 *
 * Consumes the pattern catalog and the AST tree cache populated by
 * the parse-emit phase.
 */

import { relative } from 'node:path';
import type { Language as WtsLanguage, Node as WtsNode } from 'web-tree-sitter';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import { AST_TREE_CACHE_KEY } from '../../core/pipeline.js';
import type { AstCache } from '../ast-cache.js';
import { getPatternsForLanguage } from '../patterns/index.js';
import { languageForFile } from '../languages/index.js';
import { defaultWasmDir } from '../parser.js';
// ── Types ──────────────────────────────────────────────────────────────────

export interface PatternDetectionOutput {
  /** Total number of pattern matches found. */
  matchCount: number;
  /** Number of matches per pattern category. */
  patternsByCategory: Record<string, number>;
  /** Number of distinct files containing at least one pattern match. */
  filesWithPatterns: number;
}

// ── Query helpers (exported for testability) ────────────────────────────────

/**
 * Compile a tree-sitter query from a pattern string.
 * Returns the Query object or undefined if the pattern is invalid.
 * Uses language.query() — the standard tree-sitter API.
 */
export function compileQuery(language: WtsLanguage, pattern: string): QueryLike | undefined {
  try {
    return (language as unknown as { query(p: string): QueryLike }).query(pattern);
  } catch {
    return undefined;
  }
}

/** Minimal interface for a compiled tree-sitter query. */
interface QueryLike {
  matches(node: WtsNode): Array<{ captures: Array<{ name: string; node: { text: string; startPosition: { row: number }; endPosition: { row: number } } }> }>;
  delete(): void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load (or retrieve from local cache) the WASM Language for a given
 * language definition.
 *
 * We maintain a local language cache per phase execution to avoid
 * re-loading WASM grammars for every file of the same language.
 */
async function loadLanguageCached(
  def: { load: (dir: string) => Promise<WtsLanguage>; wasmFile: string },
  wasmDir: string,
  cache: Map<string, WtsLanguage>,
): Promise<WtsLanguage> {
  const key = def.wasmFile;
  let lang = cache.get(key);
  if (!lang) {
    lang = await def.load(wasmDir);
    cache.set(key, lang);
  }
  return lang;
}

/**
 * Validate that all required captures are present in the match's capture set.
 */
function hasRequiredCaptures(
  captures: Array<{ name: string; node: { text: string } }>,
  required: string[],
): boolean {
  const captureNames = new Set(captures.map((c) => c.name));
  return required.every((name) => captureNames.has(name));
}

/**
 * Apply post-filter regex checks against captured text.
 * Returns true if ALL post-filters pass (or if no post-filters are defined).
 */
function passesPostFilters(
  captures: Array<{ name: string; node: { text: string } }>,
  postFilters: Record<string, RegExp> | undefined,
): boolean {
  if (!postFilters) return true;
  const captureMap = new Map(captures.map((c) => [c.name, c.node.text]));
  for (const [name, regex] of Object.entries(postFilters)) {
    const text = captureMap.get(name);
    if (text === undefined || !regex.test(text)) return false;
  }
  return true;
}

/**
 * Run negative indicator queries and count how many match.
 * Each matching negative indicator reduces confidence by 0.2.
 *
 * Uses `any` for rootNode to match the codebase pattern for tree-sitter nodes.
 */
function countNegativeIndicators(
  language: WtsLanguage,
  rootNode: any,
  negativeIndicators: string[] | undefined,
): number {
  if (!negativeIndicators || negativeIndicators.length === 0) return 0;
  let count = 0;
  for (const negQueryStr of negativeIndicators) {
    const q = compileQuery(language, negQueryStr);
    if (!q) continue;
    try {
      const matches = q.matches(rootNode);
      if (matches.length > 0) count++;
    } finally {
      q.delete();
    }
  }
  return count;
}

// ── Phase definition ────────────────────────────────────────────────────────

export const patternDetectionPhase: PhaseDefinition<PatternDetectionOutput> = {
  name: 'pattern-detection',
  dependencies: ['parse-emit'],

  async execute(context: PhaseContext): Promise<PatternDetectionOutput> {
    const { graph, repoPath } = context;
    const wasmDir = defaultWasmDir();

    const astCache = context.state.get(AST_TREE_CACHE_KEY) as AstCache | undefined;
    if (!astCache || astCache.size === 0) {
      return { matchCount: 0, patternsByCategory: {}, filesWithPatterns: 0 };
    }

    // Local language cache for this phase execution
    const langCache = new Map<string, WtsLanguage>();

    // Incremental: only process changed files if set
    const changedPaths = context.incremental?.changedPaths;

    let totalMatches = 0;
    const patternsByCategory: Record<string, number> = {};
    const filesWithPatternsSet = new Set<string>();

    // Iterate over all cached trees using internal Map access
    const cacheMap = (astCache as unknown as { cache: Map<string, unknown> }).cache;

    for (const absPath of cacheMap.keys()) {
      // Incremental filtering
      if (changedPaths && !changedPaths.has(absPath)) continue;

      // Determine language for this file
      const langDef = languageForFile(absPath);
      if (!langDef) continue;

      const langName = langDef.name;

      // Get patterns applicable to this language
      const patterns = getPatternsForLanguage(langName);
      if (patterns.length === 0) continue;

      // Get the cached tree entry
      const entry = astCache.get(absPath);
      if (!entry) continue;

      // Use `any` for rootNode to match codebase pattern (tree-sitter Node type)
      const rootNode: any = (entry.tree as { rootNode?: unknown }).rootNode;
      if (!rootNode) continue;

      const relPath = relative(repoPath, absPath).replace(/\\/g, '/');

      // Load the tree-sitter Language for this file's language
      let language: WtsLanguage;
      try {
        language = await loadLanguageCached(langDef, wasmDir, langCache);
      } catch {
        // Could not load language — skip this file
        continue;
      }

      // Run each pattern's signatures against this tree
      for (const patternDef of patterns) {
        const signatures = patternDef.languages[langName];
        if (!signatures) continue;

        for (const sig of signatures) {
          const query = compileQuery(language, sig.query);
          if (!query) continue;

          try {
            const matches = query.matches(rootNode);

            for (const match of matches) {
              const captures = match.captures;

              // Validate required captures
              if (sig.requiredCaptures && sig.requiredCaptures.length > 0) {
                if (!hasRequiredCaptures(captures, sig.requiredCaptures)) continue;
              }

              // Apply post-filters
              if (!passesPostFilters(captures, sig.postFilters)) continue;

              // Compute confidence
              let confidence = sig.minConfidence ?? 0.6;

              // Apply negative indicators
              const negCount = countNegativeIndicators(language, rootNode, sig.negativeIndicators);
              confidence -= negCount * 0.2;
              confidence = Math.max(confidence, 0.1);

              // Only create node if confidence is still above threshold
              if (confidence < 0.1) continue;

              // Get line numbers from first capture
              const firstCapture = captures[0];
              const startLine: number = firstCapture
                ? (firstCapture.node as { startPosition: { row: number } }).startPosition.row + 1
                : 0;
              const endLine: number = firstCapture
                ? (firstCapture.node as { endPosition: { row: number } }).endPosition.row + 1
                : 0;

              // Build captures record
              const capturesRecord: Record<string, string> = {};
              for (const c of captures) {
                capturesRecord[c.name] = c.node.text;
              }

              // Create PatternInstance node
              const nodeId = `pattern:${relPath}:${patternDef.id}:${startLine}`;
              graph.addNode({
                id: nodeId,
                label: 'PatternInstance',
                properties: {
                  name: patternDef.name,
                  patternId: patternDef.id,
                  category: patternDef.category,
                  confidence,
                  filePath: relPath,
                  startLine,
                  endLine,
                  captures: capturesRecord,
                  language: langName,
                },
              });

              // Create IMPLEMENTS_PATTERN edge from file to pattern instance
              graph.addRelationship({
                id: `implements:${relPath}:${patternDef.id}:${startLine}`,
                sourceId: `file:${relPath}`,
                targetId: nodeId,
                type: 'IMPLEMENTS_PATTERN',
                confidence,
                reason: 'pattern-detection',
              });

              totalMatches++;
              patternsByCategory[patternDef.category] = (patternsByCategory[patternDef.category] ?? 0) + 1;
              filesWithPatternsSet.add(relPath);
            }
          } finally {
            query.delete();
          }
        }
      }
    }

    return {
      matchCount: totalMatches,
      patternsByCategory,
      filesWithPatterns: filesWithPatternsSet.size,
    };
  },
};
