/**
 * Pipeline Phase: Cross-File Type Propagation
 *
 * Re-processes imports and calls with type information propagated
 * across file boundaries. Files are processed in topological import
 * order (leaves first) so upstream types are available when needed.
 *
 * Dependencies: parse-emit, resolution (both must complete first)
 * Output: Refined CALLS edges with propagated type information
 */

import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CrossFileOutput {
  propagatedEdges: number;
  filesProcessed: number;
  unresolvedBefore: number;
  unresolvedAfter: number;
}

// ── Topological sort by imports ────────────────────────────────────────────

/**
 * Build import graph: Map<filePath, importedFilePaths[]>
 */
function buildImportGraph(graph: PhaseContext['graph']): Map<string, string[]> {
  const imports = new Map<string, string[]>();
  const fileNodes = new Map<string, string>();

  // Build file node index
  for (const node of graph.iterNodes()) {
    if (node.label === 'File') {
      fileNodes.set(node.id, node.properties.filePath as string);
    }
  }

  // Map import relationships
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'IMPORTS') {
      const srcFile = graph.getNode(rel.sourceId);
      const tgtFile = graph.getNode(rel.targetId);
      const srcPath = srcFile?.properties.filePath as string | undefined;
      const tgtPath = tgtFile?.properties.filePath as string | undefined;
      if (!srcPath || !tgtPath) continue;

      let deps = imports.get(srcPath);
      if (!deps) { deps = []; imports.set(srcPath, deps); }
      if (!deps.includes(tgtPath)) deps.push(tgtPath);
    }
  }
  return imports;
}

/**
 * Topological sort: files with no imports first (leaves),
 * files that import others later.
 */
function topologicalFiles(importGraph: Map<string, string[]>): string[] {
  const allFiles = new Set<string>();
  for (const [f, deps] of importGraph) {
    allFiles.add(f);
    for (const d of deps) allFiles.add(d);
  }

  const inDegree = new Map<string, number>();
  for (const f of allFiles) inDegree.set(f, 0);
  for (const [, deps] of importGraph) {
    for (const d of deps) {
      inDegree.set(d, (inDegree.get(d) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [f, d] of inDegree) {
    if (d === 0) queue.push(f);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const f = queue.shift()!;
    sorted.push(f);
    const deps = importGraph.get(f) ?? [];
    for (const d of deps) {
      const newD = (inDegree.get(d) ?? 1) - 1;
      inDegree.set(d, newD);
      if (newD === 0) queue.push(d);
    }
  }
  return sorted;
}

// ── Type propagation ───────────────────────────────────────────────────────

/**
 * Build a type map: Map<filePath, Map<name, symbolType>>
 * For each file, collect the types (Class, Interface, Enum, TypeAlias)
 * that are exported/public from that file.
 */
function buildTypeMap(graph: PhaseContext['graph']): Map<string, Map<string, string>> {
  const typeMap = new Map<string, Map<string, string>>();
  const typeLabels = new Set(['Class', 'Interface', 'Enum', 'TypeAlias', 'Struct', 'Trait']);

  for (const node of graph.iterNodes()) {
    if (!typeLabels.has(node.label)) continue;
    const fp = node.properties.filePath as string | undefined;
    const name = node.properties.name as string | undefined;
    if (!fp || !name) continue;

    let fileTypes = typeMap.get(fp);
    if (!fileTypes) { fileTypes = new Map(); typeMap.set(fp, fileTypes); }
    fileTypes.set(name, node.label);
  }
  return typeMap;
}

// ── Phase definition ────────────────────────────────────────────────────────

export const crossFilePhase: PhaseDefinition<CrossFileOutput> = {
  name: 'cross-file',
  dependencies: ['parse-emit', 'resolution'],

  execute(context: PhaseContext): CrossFileOutput {
    const { graph } = context;

    const importGraph = buildImportGraph(graph);
    const sortedFiles = topologicalFiles(importGraph);
    const typeMap = buildTypeMap(graph);

    let propagatedEdges = 0;

    // Track resolved types per file for transitive propagation (#165)
    const resolvedTypes = new Map<string, Map<string, string>>();

    // Process files in topological order
    for (const filePath of sortedFiles) {
      // Collect types available from this file + its imports (transitive)
      const availableTypes = new Map<string, string>();
      const importDeps = importGraph.get(filePath) ?? [];

      for (const dep of importDeps) {
        // Direct types from the imported file
        const depTypes = typeMap.get(dep);
        if (depTypes) {
          for (const [name, label] of depTypes) {
            if (!availableTypes.has(name)) availableTypes.set(name, label);
          }
        }
        // Transitive types from already-resolved deps (#165)
        const depResolved = resolvedTypes.get(dep);
        if (depResolved) {
          for (const [name, label] of depResolved) {
            if (!availableTypes.has(name)) availableTypes.set(name, label);
          }
        }
      }

      // Add this file's own types
      const ownTypes = typeMap.get(filePath);
      if (ownTypes) {
        for (const [name, label] of ownTypes) {
          availableTypes.set(name, label);
        }
      }

      if (availableTypes.size === 0) continue;

      // Track resolved types for this file (for transitive propagation)
      resolvedTypes.set(filePath, new Map(availableTypes));

      // Find nodes in this file with type references
      for (const node of graph.iterNodes()) {
        const fp = node.properties.filePath as string | undefined;
        if (fp !== filePath) continue;
        if (node.label !== 'Function' && node.label !== 'Method') continue;

        // Resolve all type-reference properties, not just returnType (#163)
        const typeProps: string[] = ['returnType', 'declaredType', 'parameterTypes', 'fieldType'];
        for (const prop of typeProps) {
          const refType = node.properties[prop] as string | undefined;
          if (refType && availableTypes.has(refType)) {
            node.properties[`resolved_${prop}`] = refType;
          }
        }
      }

      propagatedEdges++;
    }

    return {
      propagatedEdges,
      filesProcessed: sortedFiles.length,
      unresolvedBefore: 0,
      unresolvedAfter: 0,
    };
  },
};
