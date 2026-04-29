/**
 * Pipeline Phase: Resolution
 *
 * Cross-file symbol resolution engine.
 * Builds global symbol index, resolves imports → target symbols, produces
 * USES and EXTENDS edges. Conservative: only high-confidence edges.
 */

import { dirname } from 'node:path';
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
  const normalized = baseDir.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  for (const p of spec.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  return parts.join('/');
}

export const resolutionPhase: PhaseDefinition<ResolutionOutput> = {
  name: 'resolution',
  dependencies: ['parse-emit'],

  execute(context: PhaseContext): ResolutionOutput {
    const { graph } = context;

    const symbolIndex = buildSymbolIndex(graph);
    const importNodes: GraphNode[] = [];
    for (const node of graph.iterNodes()) {
      if (node.label === 'Import') importNodes.push(node);
    }

    let edgeCount = 0;
    const edgeCounts: Record<string, number> = {};
    let bindingCount = 0;

    for (const impNode of importNodes) {
      const importerFile = impNode.properties.filePath as string;
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

    return {
      edgeCount,
      edgeCounts,
      fileCount: symbolIndex.size,
      bindingCount,
    };
  },
};
