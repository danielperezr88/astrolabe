/**
 * Pipeline Phase: Cross-File Type Propagation
 *
 * Resolves type references across file boundaries:
 * - Builds per-file type maps from import resolution data
 * - Processes files in topological (import-order) sequence
 * - Emits RETURNS_TYPE edges for Function/Method returnType → imported symbol
 * - Emits DECLARES_TYPE edges for declaredType resolution (pending parser capture)
 *
 * Dependencies: parse-emit, resolution (both must complete first)
 * Output: Per-file type maps, topological sorted file order, propagated edges
 */

import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import type { GraphNode, KnowledgeGraph } from '@astrolabe-dev/shared';
import { dirname } from 'node:path';
import { toPosix } from '@astrolabe-dev/shared';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CrossFileOutput {
  propagatedEdges: number;
  filesProcessed: number;
  unresolvedBefore: number;
  unresolvedAfter: number;
}

// ── Topological sort by imports ────────────────────────────────────────────

/**
 * Resolve a module specifier (e.g. './types', '../foo/bar') to a file path
 * relative to the importing file. Same logic as resolution.ts:resolveModule().
 */
function resolveModule(baseDir: string, spec: string): string {
  if (!spec.startsWith('.')) return spec;
  const normalized = toPosix(baseDir);
  const parts = normalized.split('/').filter(Boolean);
  for (const p of spec.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  // Strip leading './' when baseDir was '.' (flat file with no dir)
  const result = parts.join('/');
  return result.startsWith('./') ? result.slice(2) : result;
}

/**
 * Build import graph: Map<filePath, importedFilePaths[]>
 *
 * IMPORTS edges connect File → Import (NOT File → File).
 * This function resolves Import node module specifiers to actual file paths
 * by matching against existing File nodes (with extension flexibility).
 */
function buildImportGraph(graph: PhaseContext['graph']): Map<string, string[]> {
  const imports = new Map<string, string[]>();

  // Build index: short path → File node id (for matching)
  const fileNodes = new Map<string, string>();
  for (const node of graph.iterNodes()) {
    if (node.label === 'File') {
      fileNodes.set(node.properties.filePath as string, node.id);
    }
  }

  // Collect Import nodes and their properties
  const importNodes = new Map<string, GraphNode>();
  for (const node of graph.iterNodes()) {
    if (node.label === 'Import') {
      importNodes.set(node.id, node);
    }
  }

  // Map IMPORTS edges: File → Import → resolve to target File
  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'IMPORTS') continue;

    const srcFile = graph.getNode(rel.sourceId);
    if (!srcFile || srcFile.label !== 'File') continue;

    const srcPath = srcFile.properties.filePath as string | undefined;
    if (!srcPath) continue;

    // rel.targetId points to an Import node, NOT a File node
    const impNode = importNodes.get(rel.targetId);
    if (!impNode) continue;

    const moduleSpec = impNode.properties.name as string | undefined;
    const importerPath = impNode.properties.filePath as string | undefined;
    if (!moduleSpec || !importerPath) continue;

    // Resolve module specifier relative to importer directory
    const baseDir = dirname(importerPath);
    const resolved = resolveModule(baseDir, moduleSpec);

    // Match resolved path against File nodes (with extension flexibility)
    for (const [filePath] of fileNodes) {
      const fpNoExt = filePath.replace(/\.[^.]+$/, '');
      const resNoExt = resolved.replace(/\.[^.]+$/, '');
      if (filePath === resolved || fpNoExt === resNoExt) {
        let deps = imports.get(srcPath);
        if (!deps) { deps = []; imports.set(srcPath, deps); }
        if (!deps.includes(filePath)) deps.push(filePath);
        break; // one match is sufficient
      }
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

    // Pre-build type node index for O(1) lookup (#393)
    const typeNodesByName = new Map<string, GraphNode[]>();
    for (const node of graph.iterNodes()) {
      const tpLabel = node.label;
      if (!['Class', 'Interface', 'Enum', 'TypeAlias', 'Struct', 'Trait'].includes(tpLabel)) continue;
      const tpName = node.properties.name as string | undefined;
      if (!tpName) continue;
      let arr = typeNodesByName.get(tpName);
      if (!arr) { arr = []; typeNodesByName.set(tpName, arr); }
      arr.push(node);
    }

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
        if (node.label !== 'Function' && node.label !== 'Method' && node.label !== 'Property') continue;

        // #376: Resolve returnType to target symbol
        const returnType = node.properties.returnType as string | undefined;
        if (returnType) {
          const resolvedType = availableTypes.get(returnType);
          if (resolvedType) {
            node.properties.resolved_returnType = returnType;
            // Use pre-built index for O(1) lookup (#393) with same-file preference (#394)
            const candidates = typeNodesByName.get(returnType);
            if (candidates) {
              // Prefer same-file, then first match
              const sameFile = candidates.find((c) => c.properties.filePath === filePath);
              const best = sameFile ?? candidates[0];
              if (best.label === resolvedType) {
                const edgeId = `returns:${node.id}:${best.id}`;
                if (!graph.getRelationship(edgeId)) {
                  graph.addRelationship({
                    id: edgeId,
                    sourceId: node.id,
                    targetId: best.id,
                    type: 'RETURNS_TYPE',
                    confidence: 0.8,
                    reason: `returnType: ${returnType} resolves to ${best.label}`,
                  });
                  propagatedEdges++;
                }
              }
            }
          }
        }

        // #376: Resolve declaredType similarly
        const declaredType = node.properties.declaredType as string | undefined;
        if (declaredType) {
          const resolvedType = availableTypes.get(declaredType);
          if (resolvedType) {
            node.properties.resolved_declaredType = declaredType;
            const candidates = typeNodesByName.get(declaredType);
            if (candidates) {
              const sameFile = candidates.find((c) => c.properties.filePath === filePath);
              const best = sameFile ?? candidates[0];
              if (best.label === resolvedType) {
                const edgeId = `declares:${node.id}:${best.id}`;
                if (!graph.getRelationship(edgeId)) {
                  graph.addRelationship({
                    id: edgeId,
                    sourceId: node.id,
                    targetId: best.id,
                    type: 'DECLARES_TYPE',
                    confidence: 0.8,
                    reason: `declaredType: ${declaredType} resolves to ${best.label}`,
                  });
                  propagatedEdges++;
                }
              }
            }
          }
        }
      }
    }

    // Deep type chain resolution — creates CHAINABLE_TO edges
    const chainEdges = typeChainResolution(graph);

    return {
      propagatedEdges: propagatedEdges + chainEdges,
      filesProcessed: sortedFiles.length,
      unresolvedBefore: 0,
      unresolvedAfter: 0,
    };
  },
};

// ── Deep type chain resolution ──────────────────────────────────────────────

/** Labels that can act as chain sources via declaredType. */
const CHAIN_SOURCE_LABELS = new Set(['Property', 'Variable']);

/** Labels whose methods are chainable targets. */
const TYPE_LABELS = new Set(['Class', 'Interface']);

/**
 * Create CHAINABLE_TO edges that enable tracing call chains like
 * `user.address.getCity().toString()` through the knowledge graph.
 *
 * Runs AFTER the existing RETURNS_TYPE / DECLARES_TYPE resolution.
 * Supports up to 3 levels of chaining via iterative BFS.
 *
 * @returns Number of CHAINABLE_TO edges created.
 */
export function typeChainResolution(graph: KnowledgeGraph): number {
  const MAX_CHAIN_DEPTH = 3;
  let chainEdges = 0;

  // 1. Build class/interface → member-methods index from MEMBER_OF edges
  const classToMethods = new Map<string, GraphNode[]>();
  for (const rel of graph.iterRelationshipsByType('MEMBER_OF')) {
    const member = graph.getNode(rel.sourceId);
    if (!member || (member.label !== 'Function' && member.label !== 'Method')) continue;
    let arr = classToMethods.get(rel.targetId);
    if (!arr) { arr = []; classToMethods.set(rel.targetId, arr); }
    arr.push(member);
  }

  // 2. Build node-id → type-node-id lookups from existing edges
  const declaresTypeTargets = new Map<string, string>();
  for (const rel of graph.iterRelationshipsByType('DECLARES_TYPE')) {
    declaresTypeTargets.set(rel.sourceId, rel.targetId);
  }

  const returnsTypeTargets = new Map<string, string>();
  for (const rel of graph.iterRelationshipsByType('RETURNS_TYPE')) {
    returnsTypeTargets.set(rel.sourceId, rel.targetId);
  }

  // Helper: create a CHAINABLE_TO edge (idempotent)
  const addChainableEdge = (sourceId: string, targetId: string, reason: string): boolean => {
    const edgeId = `chain:${sourceId}:${targetId}`;
    if (graph.getRelationship(edgeId)) return false;
    graph.addRelationship({
      id: edgeId,
      sourceId,
      targetId,
      type: 'CHAINABLE_TO',
      confidence: 0.8,
      reason,
    });
    return true;
  };

  // 3. Level 1: Property/Variable with declaredType → chain to type's methods
  const chainableSources = new Set<string>();

  for (const node of graph.iterNodes()) {
    if (!CHAIN_SOURCE_LABELS.has(node.label)) continue;
    const typeNodeId = declaresTypeTargets.get(node.id);
    if (!typeNodeId) continue;

    const typeNode = graph.getNode(typeNodeId);
    if (!typeNode || !TYPE_LABELS.has(typeNode.label)) continue;

    const methods = classToMethods.get(typeNodeId) ?? [];
    const sourceName = (node.properties.name as string) ?? 'unknown';
    const typeName = (typeNode.properties.name as string) ?? 'Unknown';

    for (const method of methods) {
      const methodName = (method.properties.name as string) ?? 'unknown';
      if (addChainableEdge(
        node.id,
        method.id,
        `declared type chain: ${sourceName} → ${typeName} → ${methodName}()`,
      )) {
        chainEdges++;
        chainableSources.add(method.id);
      }
    }
  }

  // Level 1 also: Function/Method with returnType → chain to type's methods
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Function' && node.label !== 'Method') continue;
    const typeNodeId = returnsTypeTargets.get(node.id);
    if (!typeNodeId) continue;

    const typeNode = graph.getNode(typeNodeId);
    if (!typeNode || !TYPE_LABELS.has(typeNode.label)) continue;

    const methods = classToMethods.get(typeNodeId) ?? [];
    const funcName = (node.properties.name as string) ?? 'unknown';
    const typeName = (typeNode.properties.name as string) ?? 'Unknown';

    for (const method of methods) {
      const methodName = (method.properties.name as string) ?? 'unknown';
      if (addChainableEdge(
        node.id,
        method.id,
        `return type chain: ${funcName}() → ${typeName} → ${methodName}()`,
      )) {
        chainEdges++;
        chainableSources.add(method.id);
      }
    }
  }

  // 4. Levels 2–3: BFS — follow return types of chainable methods
  for (let level = 2; level <= MAX_CHAIN_DEPTH; level++) {
    const nextSources = new Set<string>();

    for (const sourceId of chainableSources) {
      const sourceNode = graph.getNode(sourceId);
      if (!sourceNode) continue;

      const returnTypeNodeId = returnsTypeTargets.get(sourceId);
      if (!returnTypeNodeId) continue;

      const typeNode = graph.getNode(returnTypeNodeId);
      if (!typeNode || !TYPE_LABELS.has(typeNode.label)) continue;

      const methods = classToMethods.get(returnTypeNodeId) ?? [];
      const sourceName = (sourceNode.properties.name as string) ?? 'unknown';
      const typeName = (typeNode.properties.name as string) ?? 'Unknown';

      for (const method of methods) {
        const methodName = (method.properties.name as string) ?? 'unknown';
        if (addChainableEdge(
          sourceId,
          method.id,
          `chain depth ${level}: ${sourceName}() → ${typeName} → ${methodName}()`,
        )) {
          chainEdges++;
          nextSources.add(method.id);
        }
      }
    }

    if (nextSources.size === 0) break;
    chainableSources.clear();
    for (const id of nextSources) chainableSources.add(id);
  }

  return chainEdges;
}
