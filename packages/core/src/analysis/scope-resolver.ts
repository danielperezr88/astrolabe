/**
 * Scope-Resolution Pipeline (#283) — language-agnostic reference resolver.
 *
 * Replaces the legacy Call-Resolution DAG for migrated languages.
 * Each language implements a ScopeResolver contract, enabling
 * true language-agnostic resolution with compile-time safety.
 *
 * Design:
 * - Single ScopeResolver interface per language
 * - Languages register via SCOPE_RESOLVERS map
 * - Migrated languages bypass legacy DAG entirely
 * - Unmigrated languages keep current behavior
 *
 * Pipeline Stages:
 * 1. ParsedFile[] (extract per file)
 * 2. ScopeResolutionIndex (classScopes, moduleScopes, typeBindings)
 * 3. ReferenceIndex (resolveReferenceSites)
 * 4. Emit edges (CALLS, ACCESSES, USES, IMPORTS)
 */

import type { KnowledgeGraph, GraphNode } from '../core/types.js';
import type { PhaseDefinition, PhaseContext } from '../core/pipeline.js';
import type { SupportedLanguage } from '@astrolabe/shared';

// ── Types ──────────────────────────────────────────────────────────────────

/** Per-class scope entry in the resolution index. */
export interface ClassScope {
  className: string;
  filePath: string;
  methods: Array<{ name: string; nodeId: string }>;
  superClasses: string[];
}

/** Per-module/file scope entry. */
export interface ModuleScope {
  filePath: string;
  symbols: Map<string, GraphNode>;
  imports: Array<{ alias: string; target: string; filePath?: string }>;
}

/** Type binding for O(1) lookup. */
export interface TypeBinding {
  symbolName: string;
  filePath: string;
  nodeId: string;
  kind: string;
}

/** Scope resolution indexes (O(1) lookups). */
export interface ScopeResolutionIndex {
  classScopes: Map<string, ClassScope>;
  moduleScopes: Map<string, ModuleScope>;
  typeBindings: Map<string, TypeBinding>;
}

/** Emitted edges from scope resolution. */
export interface ResolvedEdge {
  sourceId: string;
  targetId: string;
  type: 'CALLS' | 'ACCESSES' | 'USES' | 'IMPORTS';
  confidence: number;
  reason: string;
}

/** Hook specifications that a language must implement. */
export interface ScopeResolver {
  /** Language this resolver is for. */
  name: SupportedLanguage;

  /**
   * Populate ownership information: for each class, list which methods it owns.
   * Used by buildMro() for method resolution order.
   */
  populateOwners(index: ScopeResolutionIndex, graph: KnowledgeGraph): void;

  /**
   * Build MRO (Method Resolution Order) for class hierarchies.
   * Uses the language's mroStrategy to determine inheritance chain.
   */
  buildMro(classScope: ClassScope, index: ScopeResolutionIndex): string[];

  /**
   * Resolve an import target to a file path and exported symbols.
   * Language-specific: Python dotted paths, Go module paths, etc.
   */
  resolveImportTarget(
    importSpec: string,
    fromFile: string,
    index: ScopeResolutionIndex,
  ): { filePath?: string; symbols: string[] };

  /**
   * Determine whether two parameter lists are compatible for method override checks.
   */
  arityCompatibility(arityA: number, arityB: number): boolean;

  /**
   * Emit edges for resolved references.
   */
  emitEdges(
    edges: ResolvedEdge[],
    graph: KnowledgeGraph,
  ): number;
}

// ── Default resolver (shared logic) ────────────────────────────────────────

const defaultResolver: Partial<ScopeResolver> = {
  arityCompatibility(a: number, b: number): boolean {
    return a === b;
  },

  emitEdges(edges: ResolvedEdge[], graph: KnowledgeGraph): number {
    let count = 0;
    for (const edge of edges) {
      const edgeId = `res:${edge.sourceId}:${edge.type}:${edge.targetId}`;
      if (graph.getRelationship(edgeId)) continue;
      graph.addRelationship({
        id: edgeId,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        type: edge.type,
        confidence: edge.confidence,
        reason: edge.reason,
      });
      count++;
    }
    return count;
  },
};

// ── Python resolver placeholder (#283) ─────────────────────────────────────

const pythonResolver: ScopeResolver = {
  name: 'python',
  ...defaultResolver as any,

  populateOwners(index: ScopeResolutionIndex, graph: KnowledgeGraph): void {
    for (const node of graph.iterNodes()) {
      if (node.label !== 'Class') continue;
      const name = (node.properties.name as string) ?? '';
      const fp = (node.properties.filePath as string) ?? '';
      const parentClass = (node.properties.parentClass as string) ?? '';

      if (!index.classScopes.has(node.id)) {
        index.classScopes.set(node.id, {
          className: name,
          filePath: fp,
          methods: [],
          superClasses: parentClass ? [parentClass] : [],
        });
      }

      // Find methods that belong to this class
      // #365: Scope methods by file path — prevent cross-file class name collisions
      for (const method of graph.iterNodes()) {
        if (method.label === 'Method'
            && method.properties.parentClass === name
            && method.properties.filePath === fp) {
          index.classScopes.get(node.id)!.methods.push({
            name: (method.properties.name as string) ?? '',
            nodeId: method.id,
          });
        }
      }
    }
  },

  buildMro(classScope: ClassScope, _index: ScopeResolutionIndex): string[] {
    // Python uses C3 linearization
    const mro = [classScope.className];
    for (const superName of classScope.superClasses) {
      if (!mro.includes(superName)) mro.push(superName);
    }
    return mro;
  },

  resolveImportTarget(importSpec: string, _fromFile: string, index: ScopeResolutionIndex): { symbols: string[] } {
    // Python: dotted module paths → file paths
    const dotted = importSpec.replace(/\./g, '/');
    const symbols: string[] = [];
    for (const binding of index.typeBindings.values()) {
      if (binding.filePath.includes(dotted) || binding.filePath.includes(importSpec.replace(/\./g, '/'))) {
        symbols.push(binding.symbolName);
      }
    }
    return { symbols };
  },
};

// ── Registered resolvers ───────────────────────────────────────────────────

export const SCOPE_RESOLVERS = new Map<SupportedLanguage, ScopeResolver>([
  ['python', pythonResolver],
]);

// ── Index builder ──────────────────────────────────────────────────────────

function buildScopeIndex(graph: KnowledgeGraph): ScopeResolutionIndex {
  const index: ScopeResolutionIndex = {
    classScopes: new Map(),
    moduleScopes: new Map(),
    typeBindings: new Map(),
  };

  // Build module scopes (one per file)
  for (const node of graph.iterNodes()) {
    if (node.label !== 'File') continue;
    const fp = (node.properties.filePath as string) ?? '';
    if (!fp) continue;

    if (!index.moduleScopes.has(fp)) {
      index.moduleScopes.set(fp, {
        filePath: fp,
        symbols: new Map(),
        imports: [],
      });
    }

    const scope = index.moduleScopes.get(fp)!;
    for (const symNode of graph.iterNodes()) {
      if (symNode.properties.filePath === fp) {
        scope.symbols.set((symNode.properties.name as string) ?? symNode.id, symNode);
      }
    }
  }

  // #363: Populate imports from Import nodes in the graph
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Import') continue;
    const fp = (node.properties.filePath as string) ?? '';
    const alias = (node.properties.alias as string) ?? (node.properties.name as string) ?? '';
    const target = (node.properties.target as string) ?? (node.properties.importSource as string) ?? '';
    if (!fp || !alias || !target) continue;

    let scope = index.moduleScopes.get(fp);
    if (!scope) {
      scope = { filePath: fp, symbols: new Map(), imports: [] };
      index.moduleScopes.set(fp, scope);
    }
    scope.imports.push({ alias, target });
  }

  // Build type bindings for O(1) symbol lookup
  for (const node of graph.iterNodes()) {
    if (['Function', 'Class', 'Method', 'Interface', 'Enum', 'TypeAlias', 'Variable', 'Const'].includes(node.label)) {
      const name = (node.properties.name as string) ?? '';
      const fp = (node.properties.filePath as string) ?? '';
      if (!name || !fp) continue;
      index.typeBindings.set(`${fp}:${name}`, {
        symbolName: name,
        filePath: fp,
        nodeId: node.id,
        kind: node.label,
      });
    }
  }

  return index;
}

// ── Phase definition ───────────────────────────────────────────────────────

export interface ScopeResolutionOutput {
  resolverCount: number;
  edgeCount: number;
}

export const scopeResolutionPhase: PhaseDefinition<ScopeResolutionOutput> = {
  name: 'scope-resolution',
  dependencies: ['resolution'],

  execute(context: PhaseContext): ScopeResolutionOutput {
    const { graph } = context;
    const index = buildScopeIndex(graph);
    let edgeCount = 0;
    let resolverCount = 0;

    // Run each registered resolver
    for (const [_lang, resolver] of SCOPE_RESOLVERS) {
      resolverCount++;

      // 1. Populate ownership
      resolver.populateOwners(index, graph);

      // 2. Build MRO for each class
      for (const [, classScope] of index.classScopes) {
        resolver.buildMro(classScope, index);
      }

      // 3. Resolve imports → edges
      const resolvedEdges: ResolvedEdge[] = [];
      for (const [, scope] of index.moduleScopes) {
        for (const imp of scope.imports) {
          const resolved = resolver.resolveImportTarget(imp.target, scope.filePath, index);
          if (resolved.symbols.length > 0) {
            // Find source node for the import
            for (const [, node] of scope.symbols) {
              if ((node.properties.name as string) === imp.alias) {
                for (const sym of resolved.symbols) {
                  const binding = index.typeBindings.get(`${resolved.filePath ?? scope.filePath}:${sym}`);
                  if (binding) {
                    resolvedEdges.push({
                      sourceId: node.id,
                      targetId: binding.nodeId,
                      type: 'USES',
                      confidence: 0.9,
                      reason: `Import '${imp.target}' → ${sym}`,
                    });
                  }
                }
              }
            }
          }
        }
      }

      // 4. Emit edges
      edgeCount += resolver.emitEdges(resolvedEdges, graph);
    }

    return { resolverCount, edgeCount };
  },
};
