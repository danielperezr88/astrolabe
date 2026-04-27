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
  const parts = baseDir.split('/').filter(Boolean);
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

      const baseDir = dirname(importerFile);
      const resolved = resolveModule(baseDir, sourceModule);

      // Gather targets from matching files in symbol index
      const targets: GraphNode[] = [];
      for (const [fp, syms] of symbolIndex) {
        const fpNoExt = fp.replace(/\.[^.]+$/, '');
        const resNoExt = resolved.replace(/\.[^.]+$/, '');
        if (fp === resolved || fpNoExt === resNoExt || fp.startsWith(resolved + '/')) {
          for (const [, nodes] of syms) targets.push(...nodes);
        }
      }

      for (const target of targets) {
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

      // EXTENDS heuristic: if Class imported, check importer classes
      for (const target of targets) {
        if (target.label !== 'Class') continue;
        const tName = target.properties.name as string;
        const fileSyms = symbolIndex.get(importerFile);
        if (!fileSyms) continue;
        for (const [, nodes] of fileSyms) {
          for (const cls of nodes) {
            if (cls.label !== 'Class') continue;
            const cName = cls.properties.name as string;
            const extId = `res:${cls.id}:extends:${target.id}`;
            if (graph.getRelationship(extId)) continue;
            if (tName && cName && tName !== cName) {
              graph.addRelationship({
                id: extId,
                sourceId: cls.id,
                targetId: target.id,
                type: 'EXTENDS',
                confidence: 0.5,
                reason: `Class ${cName} imports ${tName} — possible extends`,
              });
              edgeCount++;
              edgeCounts['EXTENDS'] = (edgeCounts['EXTENDS'] ?? 0) + 1;
            }
          }
        }
      }
    }

    return {
      edgeCount,
      edgeCounts,
      fileCount: symbolIndex.size,
      bindingCount,
    };
  },
};
