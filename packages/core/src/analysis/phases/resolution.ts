/**
 * Pipeline Phase: Resolution
 *
 * Cross-file symbol resolution engine.
 * Builds global symbol index, resolves imports → target symbols, produces
 * USES and EXTENDS edges. Conservative: only high-confidence edges.
 */

import { dirname } from 'node:path';
import { toPosix } from '@astrolabe-dev/shared';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import type { GraphNode } from '../../core/types.js';
import { languageForFile } from '../languages/index.js';

export interface ResolutionOutput {
  edgeCount: number;
  edgeCounts: Record<string, number>;
  fileCount: number;
  bindingCount: number;
}

type SymbolIndex = Map<string, Map<string, GraphNode[]>>;

const RESOLVABLE_LABELS = new Set([
  'Function', 'Class', 'Method', 'Interface', 'Enum',
  'TypeAlias', 'Variable', 'Const',
]);

function buildSymbolIndex(graph: PhaseContext['graph']): SymbolIndex {
  const idx: SymbolIndex = new Map();
  for (const node of graph.iterNodes()) {
    const fp = node.properties.filePath as string;
    const name = node.properties.name as string;
    if (!fp || !name) continue;
    if (!RESOLVABLE_LABELS.has(node.label)) continue;
    let fm = idx.get(fp);
    if (!fm) { fm = new Map(); idx.set(fp, fm); }
    let ns = fm.get(name);
    if (!ns) { ns = []; fm.set(name, ns); }
    ns.push(node);
  }
  return idx;
}

function resolveModule(baseDir: string, spec: string): string {
  if (!spec.startsWith('.')) return spec;
  // Normalize to forward slashes for cross-platform compatibility (#144)
  const normalized = toPosix(baseDir);
  const parts = normalized.split('/').filter(Boolean);
  for (const p of spec.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  return parts.join('/');
}

/**
 * Check if a string looks like an import path (starts with . or /)
 */
function isImportPath(value: string): boolean {
  return value.startsWith('.') || value.startsWith('/');
}

/**
 * Wildcard synthesis: resolve dynamic/glob import patterns using cross-file binding info.
 * Common pattern: const modulePath = './utils'; require(modulePath);
 */
function synthesizeWildcardImports(
  graph: PhaseContext['graph'],
  symbolIndex: SymbolIndex
): number {
  let resolved = 0;

  // Phase 1: Collect string assignments from Variable/Const nodes per file
  // Map<filePath, Map<varName, assignedStringValue>>
  const fileBindings = new Map<string, Map<string, string>>();

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Variable' && node.label !== 'Const') continue;
    const fp = node.properties.filePath as string;
    const name = node.properties.name as string;
    if (!fp || !name) continue;

    // Capture assigned string value (if parser populates it)
    const value = node.properties.value as string | undefined;
    if (value && typeof value === 'string' && isImportPath(value)) {
      let bindings = fileBindings.get(fp);
      if (!bindings) { bindings = new Map(); fileBindings.set(fp, bindings); }
      bindings.set(name, value);
    }
  }

  // Phase 2: Find unresolved imports that reference variables
  for (const impNode of graph.iterNodes()) {
    if (impNode.label !== 'Import') continue;
    const fp = impNode.properties.filePath as string;
    const importName = impNode.properties.name as string;
    if (!fp || !importName) continue;

    // Skip if it looks like a static path (already handled by main resolution)
    if (importName.startsWith('.') || importName.startsWith('/')) continue;

    // Look up binding for this variable
    const bindings = fileBindings.get(fp);
    const resolvedPath = bindings?.get(importName);
    if (!resolvedPath) continue;

    // Resolve using same logic as main resolution
    const baseDir = dirname(fp);
    const resolvedModule = resolveModule(baseDir, resolvedPath);

    // Find matching targets in symbol index
    for (const [targetFp, symMap] of symbolIndex) {
      const targetFpNoExt = targetFp.replace(/\.[^.]+$/, '');
      const resolvedNoExt = resolvedModule.replace(/\.[^.]+$/, '');

      // Exact file match (with or without extension)
      if (targetFp === resolvedModule || targetFpNoExt === resolvedNoExt) {
        for (const [, nodes] of symMap) {
          for (const target of nodes) {
            const edgeId = `wild:${impNode.id}:to:${target.id}`;
            if (graph.getRelationship(edgeId)) continue;

            graph.addRelationship({
              id: edgeId,
              sourceId: impNode.id,
              targetId: target.id,
              type: 'USES',
              confidence: 0.6, // Lower confidence than static imports
              reason: `wildcard import '${importName}' → '${resolvedPath}'`,
            });
            resolved++;
          }
        }
      }

      // Directory import
      if (targetFp.startsWith(resolvedModule + '/')) {
        const subPath = targetFp.slice(resolvedModule.length + 1);
        if (!subPath.includes('/')) {
          for (const [, nodes] of symMap) {
            for (const target of nodes) {
              const edgeId = `wild:${impNode.id}:to:${target.id}`;
              if (graph.getRelationship(edgeId)) continue;

              graph.addRelationship({
                id: edgeId,
                sourceId: impNode.id,
                targetId: target.id,
                type: 'USES',
                confidence: 0.6,
                reason: `wildcard import '${importName}' → '${resolvedPath}'`,
              });
              resolved++;
            }
          }
        }
      }
    }
  }

  return resolved;
}

export const resolutionPhase: PhaseDefinition<ResolutionOutput> = {
  name: 'resolution',
  dependencies: ['parse-emit'],

  // #632: Skip if incremental and no files changed (no new imports possible)
  shouldSkip(context: PhaseContext): boolean {
    const inc = context.incremental;
    if (!inc?.isIncremental) return false;
    return inc.changedPaths.size + inc.addedPaths.size === 0;
  },

  execute(context: PhaseContext): ResolutionOutput {
    const { graph, incremental } = context;

    const symbolIndex = buildSymbolIndex(graph);
    const importNodes: GraphNode[] = [];
    for (const node of graph.iterNodes()) {
      if (node.label === 'Import') importNodes.push(node);
    }

    let edgeCount = 0;
    const edgeCounts: Record<string, number> = {};
    let bindingCount = 0;

    // #632: In incremental mode, only process imports from changed/added files.
    // Unchanged files' imports were resolved in the previous run — their USES
    // edges are already in the graph (loaded from DB). We still need the full
    // symbolIndex so that import nodes from changed files can resolve targets
    // in unchanged files.
    const affectedFiles = incremental?.isIncremental
      ? new Set([...incremental.changedPaths, ...incremental.addedPaths])
      : null;

    for (const impNode of importNodes) {
      const importerFile = impNode.properties.filePath as string;
      if (affectedFiles && importerFile && !affectedFiles.has(importerFile)) continue;
      const sourceModule = impNode.properties.name as string;
      if (!importerFile || !sourceModule) continue;

      // #279, #347: Apply language-specific import resolution strategy
      const lang = languageForFile(importerFile);
      const semantics = lang?.importSemantics ?? 'named';
      let resolvedSource = sourceModule;

      // Namespace (Python): dotted paths resolve to directory-prefixed files
      if (semantics === 'namespace') {
        resolvedSource = sourceModule.replace(/\./g, '/'); // my.module → my/module
      }

      const baseDir = dirname(importerFile);
      const resolved = resolveModule(baseDir, resolvedSource);

      // Named imports: only match symbols with imported names (#182)
      const importedNames = impNode.properties.importedNames as string[] | undefined;
      const isNamedImport = importedNames && importedNames.length > 0;
      const nameFilter = isNamedImport ? new Set(importedNames) : null;

      // Gather targets from matching files in symbol index
      const targets: GraphNode[] = [];
      for (const [fp, syms] of symbolIndex) {
        const fpNoExt = fp.replace(/\.[^.]+$/, '');
        const resNoExt = resolved.replace(/\.[^.]+$/, '');

        // Exact file match (with or without extension)
        if (fp === resolved || fpNoExt === resNoExt) {
          // #246: Only collect symbols matching the import names, not ALL symbols
          if (nameFilter) {
            for (const [name, nodes] of syms) {
              if (nameFilter.has(name)) targets.push(...nodes);
            }
          }
          // Side-effect imports (no named imports) → skip all symbols
          continue;
        }

        // Directory import: only match files directly in that directory,
        // not recursive — avoids massive edge inflation (#171)
        if (fp.startsWith(resolved + '/')) {
          const subPath = fp.slice(resolved.length + 1);
          if (!subPath.includes('/')) {
            // #246: Filter to only explicitly imported symbols
            if (nameFilter) {
              for (const [name, nodes] of syms) {
                if (nameFilter.has(name)) targets.push(...nodes);
              }
            }
          }
        }
      }

      for (const target of targets) {
        const targetName = target.properties.name as string;

        // Named import filter: only link to symbols with matching names (#182)
        if (nameFilter && targetName && !nameFilter.has(targetName)) continue;

        const edgeId = `res:${impNode.id}:to:${target.id}`;
        if (graph.getRelationship(edgeId)) continue;
        bindingCount++;
        edgeCount++;
        edgeCounts['USES'] = (edgeCounts['USES'] ?? 0) + 1;
        graph.addRelationship({
          id: edgeId,
          sourceId: impNode.id,
          targetId: target.id,
          type: 'USES',
          confidence: 0.8,
          reason: `import '${sourceModule}' → ${target.id}`,
        });
      }

      // EXTENDS edges: only if class AST reveals explicit extends clause
      // Removed weak heuristic that created false-positive EXTENDS edges
      // just because a class imported another class (#65, #60)
    }

    // Wildcard synthesis: resolve dynamic imports using binding info
    const synthesized = synthesizeWildcardImports(graph, symbolIndex);
    edgeCount += synthesized;
    if (synthesized > 0) {
      edgeCounts['USES'] = (edgeCounts['USES'] ?? 0) + synthesized;
    }

    return {
      edgeCount,
      edgeCounts,
      fileCount: symbolIndex.size,
      bindingCount,
    };
  },
};
