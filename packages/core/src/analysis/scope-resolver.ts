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
    // #420: Build per-file node index ONCE — O(N) instead of O(N²)
    const nodesByFile = new Map<string, GraphNode[]>();
    for (const node of graph.iterNodes()) {
      const fp = node.properties.filePath as string;
      if (fp) {
        let arr = nodesByFile.get(fp);
        if (!arr) { arr = []; nodesByFile.set(fp, arr); }
        arr.push(node);
      }
    }

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
      // #420: Use per-file index instead of O(N) scan
      const fileNodes = nodesByFile.get(fp) ?? [];
      for (const method of fileNodes) {
        if (method.label === 'Method'
            && method.properties.parentClass === name) {
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
      if (binding.filePath.includes(dotted)) { // #418: removed redundant condition — both sides were identical
        symbols.push(binding.symbolName);
      }
    }
    return { symbols };
  },
};

// ── TypeScript resolver (#283) ──────────────────────────────────────────────

const typescriptResolver: ScopeResolver = {
  name: 'typescript',
  ...defaultResolver as any,

  populateOwners(index: ScopeResolutionIndex, graph: KnowledgeGraph): void {
    const nodesByFile = new Map<string, GraphNode[]>();
    for (const node of graph.iterNodes()) {
      const fp = node.properties.filePath as string;
      if (fp) {
        let arr = nodesByFile.get(fp);
        if (!arr) { arr = []; nodesByFile.set(fp, arr); }
        arr.push(node);
      }
    }

    for (const node of graph.iterNodes()) {
      if (node.label !== 'Class') continue;
      const name = (node.properties.name as string) ?? '';
      const fp = (node.properties.filePath as string) ?? '';
      const parentClass = (node.properties.parentClass as string) ?? '';
      const interfaces = (node.properties.interfaces as string[]) ?? [];

      if (!index.classScopes.has(node.id)) {
        index.classScopes.set(node.id, {
          className: name,
          filePath: fp,
          methods: [],
          superClasses: [...(parentClass ? [parentClass] : []), ...interfaces],
        });
      }

      const fileNodes = nodesByFile.get(fp) ?? [];
      for (const method of fileNodes) {
        if (method.label === 'Method'
            && method.properties.parentClass === name) {
          index.classScopes.get(node.id)!.methods.push({
            name: (method.properties.name as string) ?? '',
            nodeId: method.id,
          });
        }
      }
    }
  },

  buildMro(classScope: ClassScope, index: ScopeResolutionIndex): string[] {
    // TypeScript: single inheritance (extends) + implements — linear chain
    const mro = [classScope.className];
    for (const superName of classScope.superClasses) {
      if (!mro.includes(superName)) mro.push(superName);
      // Walk up hierarchy via classScopes
      for (const [, scope] of index.classScopes) {
        if (scope.className === superName) {
          for (const parent of scope.superClasses) {
            if (!mro.includes(parent)) mro.push(parent);
          }
        }
      }
    }
    return mro;
  },

  resolveImportTarget(importSpec: string, _fromFile: string, index: ScopeResolutionIndex): { filePath?: string; symbols: string[] } {
    const symbols: string[] = [];

    // Relative imports: ./module or ../module → resolve to file path
    let resolved = importSpec;
    if (resolved.startsWith('./') || resolved.startsWith('../')) {
      resolved = resolved.replace(/^\.\//, '').replace(/^\.\.\//, '');
      // Strip extension if present
      resolved = resolved.replace(/\.(ts|tsx|js|jsx)$/, '');
    }
    // Path aliases: @/ prefix → strip and resolve
    else if (resolved.startsWith('@/')) {
      resolved = resolved.replace(/^@\//, '');
    }
    // Bare specifier → strip extension
    else {
      resolved = resolved.replace(/\.(ts|tsx|js|jsx)$/, '');
    }

    for (const binding of index.typeBindings.values()) {
      if (binding.filePath.includes(resolved)) {
        symbols.push(binding.symbolName);
      }
    }

    // Fallback: match by symbol name for bare specifiers
    if (symbols.length === 0) {
      for (const binding of index.typeBindings.values()) {
        if (binding.symbolName === importSpec) {
          symbols.push(binding.symbolName);
        }
      }
    }

    return { symbols };
  },

  arityCompatibility(a: number, b: number): boolean {
    // TypeScript allows optional params — tolerate small arity differences
    return Math.abs(a - b) <= 2;
  },
};

// ── Java resolver (#283) ────────────────────────────────────────────────────

const javaResolver: ScopeResolver = {
  name: 'java',
  ...defaultResolver as any,

  populateOwners(index: ScopeResolutionIndex, graph: KnowledgeGraph): void {
    const nodesByFile = new Map<string, GraphNode[]>();
    for (const node of graph.iterNodes()) {
      const fp = node.properties.filePath as string;
      if (fp) {
        let arr = nodesByFile.get(fp);
        if (!arr) { arr = []; nodesByFile.set(fp, arr); }
        arr.push(node);
      }
    }

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

      const fileNodes = nodesByFile.get(fp) ?? [];
      for (const method of fileNodes) {
        if (method.label === 'Method'
            && method.properties.parentClass === name) {
          index.classScopes.get(node.id)!.methods.push({
            name: (method.properties.name as string) ?? '',
            nodeId: method.id,
          });
        }
      }
    }
  },

  buildMro(classScope: ClassScope, index: ScopeResolutionIndex): string[] {
    // Java: single inheritance — walk up via classScopes
    const mro = [classScope.className];
    let current = classScope;
    while (current.superClasses.length > 0) {
      const parentName = current.superClasses[0];
      if (!parentName || mro.includes(parentName)) break;
      mro.push(parentName);
      // Find parent class scope
      let found = false;
      for (const [, scope] of index.classScopes) {
        if (scope.className === parentName) {
          current = scope;
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    return mro;
  },

  resolveImportTarget(importSpec: string, _fromFile: string, index: ScopeResolutionIndex): { filePath?: string; symbols: string[] } {
    const symbols: string[] = [];

    // Java uses package paths: com.example.Service → find file containing that path
    const pathForm = importSpec.replace(/\./g, '/');

    for (const binding of index.typeBindings.values()) {
      if (binding.filePath.includes(pathForm)) {
        symbols.push(binding.symbolName);
      }
    }

    // Fallback: match by symbol name (last segment of package path)
    if (symbols.length === 0) {
      const lastSegment = importSpec.split('.').pop() ?? importSpec;
      for (const binding of index.typeBindings.values()) {
        if (binding.symbolName === lastSegment) {
          symbols.push(binding.symbolName);
        }
      }
    }

    return { symbols };
  },

  // Java has strict arity — uses defaultResolver exact match
};

// ── C# resolver (#283) ──────────────────────────────────────────────────────

const csharpResolver: ScopeResolver = {
  name: 'csharp',
  ...defaultResolver as any,

  populateOwners(index: ScopeResolutionIndex, graph: KnowledgeGraph): void {
    const nodesByFile = new Map<string, GraphNode[]>();
    for (const node of graph.iterNodes()) {
      const fp = node.properties.filePath as string;
      if (fp) {
        let arr = nodesByFile.get(fp);
        if (!arr) { arr = []; nodesByFile.set(fp, arr); }
        arr.push(node);
      }
    }

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

      const fileNodes = nodesByFile.get(fp) ?? [];
      for (const method of fileNodes) {
        if (method.label === 'Method'
            && method.properties.parentClass === name) {
          index.classScopes.get(node.id)!.methods.push({
            name: (method.properties.name as string) ?? '',
            nodeId: method.id,
          });
        }
      }
    }
  },

  buildMro(classScope: ClassScope, index: ScopeResolutionIndex): string[] {
    // C#: single inheritance — walk up hierarchy via classScopes
    const mro = [classScope.className];
    let current = classScope;
    while (current.superClasses.length > 0) {
      const parentName = current.superClasses[0];
      if (!parentName || mro.includes(parentName)) break;
      mro.push(parentName);
      let found = false;
      for (const [, scope] of index.classScopes) {
        if (scope.className === parentName) {
          current = scope;
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    return mro;
  },

  resolveImportTarget(importSpec: string, _fromFile: string, index: ScopeResolutionIndex): { filePath?: string; symbols: string[] } {
    const symbols: string[] = [];

    // C# uses namespace paths: MyApp.Services.UserService → find file
    const pathForm = importSpec.replace(/\./g, '/');

    for (const binding of index.typeBindings.values()) {
      if (binding.filePath.includes(pathForm)) {
        symbols.push(binding.symbolName);
      }
    }

    // Fallback: match by symbol name (last segment)
    if (symbols.length === 0) {
      const lastSegment = importSpec.split('.').pop() ?? importSpec;
      for (const binding of index.typeBindings.values()) {
        if (binding.symbolName === lastSegment) {
          symbols.push(binding.symbolName);
        }
      }
    }

    return { symbols };
  },

  arityCompatibility(a: number, b: number): boolean {
    // C# supports optional params (default values) — heuristic: allow ±1 arity difference
    return Math.abs(a - b) <= 1;
  },
};

// ── Registered resolvers ───────────────────────────────────────────────────

export const SCOPE_RESOLVERS = new Map<SupportedLanguage, ScopeResolver>([
  ['python', pythonResolver],
  ['typescript', typescriptResolver],
  ['javascript', typescriptResolver],
  ['tsx', typescriptResolver],
  ['java', javaResolver],
  ['csharp', csharpResolver],
]);

// ── Index builder ──────────────────────────────────────────────────────────

function buildScopeIndex(graph: KnowledgeGraph): ScopeResolutionIndex {
  const index: ScopeResolutionIndex = {
    classScopes: new Map(),
    moduleScopes: new Map(),
    typeBindings: new Map(),
  };

  // #420: Build per-file node index ONCE — O(N) instead of O(N²)
  const nodesByFile = new Map<string, GraphNode[]>();
  for (const node of graph.iterNodes()) {
    const fp = node.properties.filePath as string;
    if (fp) {
      let arr = nodesByFile.get(fp);
      if (!arr) { arr = []; nodesByFile.set(fp, arr); }
      arr.push(node);
    }
  }

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
    const fileNodes = nodesByFile.get(fp) ?? []; // #420: O(1) lookup instead of O(N) scan
    for (const symNode of fileNodes) {
      scope.symbols.set((symNode.properties.name as string) ?? symNode.id, symNode);
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
            // #421: Use direct Map lookup instead of O(N) iteration
            const node = scope.symbols.get(imp.alias);
            if (node) {
              for (const sym of resolved.symbols) {
                const binding = index.typeBindings.get(`${scope.filePath}:${sym}`); // #419: use scope.filePath (resolved.filePath is always undefined)
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

      // 4. Emit edges
      edgeCount += resolver.emitEdges(resolvedEdges, graph);
    }

    return { resolverCount, edgeCount };
  },
};
