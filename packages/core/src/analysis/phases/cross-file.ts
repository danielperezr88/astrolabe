/**
 * Pipeline Phase: Cross-File Type Propagation
 *
 * Builds type maps and topological import order across files.
 *
 * ⚠️  DEFERRED (#234): The actual cross-file type reference resolution
 * (resolving Function.returnType → target Class node) requires parser support
 * for capturing returnType/declaredType/parameterTypes on Function/Method nodes.
 * Until the parser populates these properties, the phase only builds type maps
 * and file ordering — it does NOT emit type-reference relationships.
 *
 * See tracking issue #234 and parser enhancement #164 for details.
 *
 * Dependencies: parse-emit, resolution (both must complete first)
 * Output: Per-file type maps and topological sorted file order
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
  // #288: Reverse so dependencies (leaves) are processed before dependents.
  // Original sort puts entry points first; type propagation needs leaves first.
  return sorted.reverse();
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

        // #376: Resolve returnType to target symbol
        const returnType = node.properties.returnType as string | undefined;
        if (returnType) {
          const resolvedType = availableTypes.get(returnType);
          if (resolvedType) {
            // Store resolved type name for downstream consumption
            node.properties.resolved_returnType = returnType;

            // Create RETURNS_TYPE edge to the target type symbol
            for (const typeNode of graph.iterNodes()) {
              if (typeNode.properties.name === returnType &&
                  typeNode.properties.filePath &&
                  typeNode.label === resolvedType) {
                const edgeId = `returns:${node.id}:${typeNode.id}`;
                if (!graph.getRelationship(edgeId)) {
                  graph.addRelationship({
                    id: edgeId,
                    sourceId: node.id,
                    targetId: typeNode.id,
                    type: 'RETURNS_TYPE',
                    confidence: 0.8,
                    reason: `returnType: ${returnType} resolves to ${typeNode.label}`,
                  });
                  propagatedEdges++;
                }
                break;
              }
            }
          }
        }

        // #376: Resolve fieldType / declaredType similarly
        const declaredType = node.properties.declaredType as string | undefined;
        if (declaredType) {
          const resolvedType = availableTypes.get(declaredType);
          if (resolvedType) {
            node.properties.resolved_declaredType = declaredType;
            for (const typeNode of graph.iterNodes()) {
              if (typeNode.properties.name === declaredType &&
                  typeNode.properties.filePath &&
                  typeNode.label === resolvedType) {
                const edgeId = `declares:${node.id}:${typeNode.id}`;
                if (!graph.getRelationship(edgeId)) {
                  graph.addRelationship({
                    id: edgeId,
                    sourceId: node.id,
                    targetId: typeNode.id,
                    type: 'DECLARES_TYPE',
                    confidence: 0.8,
                    reason: `declaredType: ${declaredType} resolves to ${typeNode.label}`,
                  });
                  propagatedEdges++;
                }
                break;
              }
            }
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
