/**
 * Pipeline Phase: MRO (Method Resolution Order)
 *
 * Computes C3 linearization for class hierarchies traversing
 * the EXTENDS edges produced by the resolution phase. Produces
 * per-Class MRO lists and HAS_METHOD edges encoding dispatch order.
 *
 * References:
 * - C3 linearization: https://en.wikipedia.org/wiki/C3_linearization
 * - Python MRO: https://www.python.org/download/releases/2.3/mro/
 */

import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import type { GraphNode } from '../../core/types.js';
import { languageForFile } from '../languages/index.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface MroOutput {
  /** Number of class hierarchies processed. */
  classCount: number;
  /** Number of EXTENDS edges traversed. */
  extendsEdgeCount: number;
  /** Max hierarchy depth found. */
  maxDepth: number;
  /** Number of HAS_METHOD edges created for method resolution. */
  methodEdgeCount: number;
}

// ── First-Wins Walk (#351) ─────────────────────────────────────────────────

/**
 * Simple parent-first DFS walk for languages without C3 (Java, C#, Go, etc.).
 * Visits each parent in declaration order, skipping duplicates.
 */
function firstWinsWalk(
  classId: string,
  parentMap: Map<string, string[]>,
): string[] {
  const result: string[] = [classId];
  const seen = new Set<string>([classId]);
  const stack = [...(parentMap.get(classId) ?? [])];

  while (stack.length > 0) {
    const current = stack.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    result.push(current);

    // Push this parent's parents in order
    const grandparents = parentMap.get(current) ?? [];
    for (const gp of grandparents) {
      if (!seen.has(gp)) stack.push(gp);
    }
  }

  return result;
}

// ── C3 Linearization ───────────────────────────────────────────────────────

/**
 * Compute C3 linearization for a class hierarchy graph.
 *
 * Returns a topological ordering of classes consistent with the
 * local precedence order (declared order of parent classes).
 *
 * Algorithm:
 * 1. For each class C, linearize(C) = [C] + merge(linearizations of parents, list of parents)
 * 2. merge: take the head of the first list that doesn't appear in the tail of any other list
 * 3. If no such head exists, the hierarchy is inconsistent → fall back to depth-first
 */
function c3Linearize(
  classId: string,
  parentMap: Map<string, string[]>,
  cache: Map<string, string[]>,
  visited: Set<string> = new Set(),
): string[] {
  if (cache.has(classId)) return cache.get(classId)!;

  // #233: Detect cycles (e.g., A extends B, B extends A) to prevent infinite recursion
  if (visited.has(classId)) return [classId];
  visited.add(classId);

  const parentIds = parentMap.get(classId) ?? [];
  if (parentIds.length === 0) {
    const result = [classId];
    cache.set(classId, result);
    return result;
  }

  // Recursively linearize all parents using the actual parent map (#61)
  const parentLinearizations = parentIds.map((pid) => c3Linearize(pid, parentMap, cache, visited));
  const result = [classId, ...c3Merge(parentLinearizations, parentIds.map((id) => [id]))];
  cache.set(classId, result);
  return result;
}

/**
 * C3 merge operation: repeatedly select the first element of the first
 * list that is not in the tail of any other list.
 */
function c3Merge(lists: string[][], parentLists: string[][]): string[] {
  const working = lists.map((l) => [...l]);
  const result: string[] = [];

  while (working.some((l) => l.length > 0)) {
    // Rebuild allLists each iteration so tail checks are correct (#146)
    const allLists = [parentLists.flat(), ...working.map((l) => l.slice(1))];
    let found = false;

    for (const list of working) {
      if (list.length === 0) continue;
      const head = list[0];
      const inTail = allLists.some((l) => l.slice(1).includes(head));
      if (!inTail) {
        result.push(head);
        // Remove head from all lists
        for (const l of working) {
          if (l.length > 0 && l[0] === head) l.shift();
        }
        found = true;
        break;
      }
    }

    if (!found) {
      // Inconsistent hierarchy — fall back to depth-first
      for (const list of working) {
        if (list.length > 0 && !result.includes(list[0])) {
          result.push(list[0]);
        }
      }
      break;
    }
  }

  return result;
}

// ── Graph traversal ─────────────────────────────────────────────────────────

/**
 * Build a parent map from EXTENDS edges in the graph.
 * Returns Map<classId, parentIds[]>
 */
function buildParentMap(graph: PhaseContext['graph']): Map<string, string[]> {
  const parents = new Map<string, string[]>();

  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'EXTENDS') {
      let pList = parents.get(rel.sourceId);
      if (!pList) {
        pList = [];
        parents.set(rel.sourceId, pList);
      }
      pList.push(rel.targetId);
    }
  }

  return parents;
}

/**
 * Find all Class nodes that have no outgoing EXTENDS edges (roots)
 * or have EXTENDS edges (can be leaf or intermediate).
 */
function findClassNodes(graph: PhaseContext['graph']): GraphNode[] {
  const classes: GraphNode[] = [];
  for (const node of graph.iterNodes()) {
    if (node.label === 'Class') classes.push(node);
  }
  return classes;
}

// ── Phase definition ────────────────────────────────────────────────────────

export const mroPhase: PhaseDefinition<MroOutput> = {
  name: 'mro',
  dependencies: ['resolution'],

  execute(context: PhaseContext): MroOutput {
    const { graph } = context;

    const parentMap = buildParentMap(graph);
    const classNodes = findClassNodes(graph);

    // Build method index: Map<filePath, methodNode[]> for O(1) lookup (#68)
    const methodsByFile = new Map<string, GraphNode[]>();
    for (const node of graph.iterNodes()) {
      if (node.label === 'Method') {
        const fp = node.properties.filePath as string | undefined;
        if (!fp) continue;
        let bucket = methodsByFile.get(fp);
        if (!bucket) { bucket = []; methodsByFile.set(fp, bucket); }
        bucket.push(node);
      }
    }

    const cache = new Map<string, string[]>();
    let extendsEdgeCount = 0;
    let maxDepth = 0;
    let methodEdgeCount = 0;

    // Compute MRO for each class
    for (const cls of classNodes) {
      const parentIds = parentMap.get(cls.id) ?? [];
      extendsEdgeCount += parentIds.length;

      if (parentIds.length > 0) {
        // #278, #351: Apply language-specific MRO strategy
        const fp = cls.properties.filePath as string | undefined;
        const lang = fp ? languageForFile(fp) : undefined;
        const strategy = lang?.mroStrategy ?? 'c3';

        let mro: string[];
        if (strategy === 'none') {
          mro = [cls.id]; // Single inheritance — no parent walk
        } else if (strategy === 'first-wins') {
          mro = firstWinsWalk(cls.id, parentMap);
        } else {
          mro = c3Linearize(cls.id, parentMap, cache);
        }

        const depth = mro.length - 1;
        if (depth > maxDepth) maxDepth = depth;

        cls.properties.mro = mro;
        cls.properties.mroDepth = depth;

        // Create HAS_METHOD edges for inherited methods
        for (const ancestorId of mro.slice(1)) {
          const ancestor = graph.getNode(ancestorId);
          if (!ancestor) continue;

          const ancestorFp = ancestor.properties.filePath as string | undefined;
          if (!ancestorFp) continue;

          const methods = methodsByFile.get(ancestorFp) ?? [];
          // Filter methods to just those belonging to this ancestor class (#121)
          // #295: Skip ancestors with no name — fallback to ALL methods causes
          // sibling method pollution in files with multiple classes
          const ancestorName = ancestor.properties.name as string;
          if (!ancestorName) continue;
          const ownMethods = methods.filter((m) => (m.properties.parentClass as string) === ancestorName);
          for (const method of ownMethods) {
            const edgeId = `mro:${cls.id}:has_method:${method.id}`;
            if (!graph.getRelationship(edgeId)) {
              graph.addRelationship({
                id: edgeId,
                sourceId: cls.id,
                targetId: method.id,
                type: 'HAS_METHOD',
                confidence: 0.9,
                reason: `MRO: ${cls.properties.name} inherits ${method.properties.name} from ${ancestor.properties.name}`,
              });
              methodEdgeCount++;
            }
          }
        }
      }
    }

    return {
      classCount: classNodes.length,
      extendsEdgeCount,
      maxDepth,
      methodEdgeCount,
    };
  },
};
