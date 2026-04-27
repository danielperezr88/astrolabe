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
  parents: string[][],
  cache: Map<string, string[]>,
): string[] {
  if (cache.has(classId)) return cache.get(classId)!;

  if (parents.length === 0) {
    const result = [classId];
    cache.set(classId, result);
    return result;
  }

  // Recursively linearize all parents
  const parentLinearizations = parents.map((p) => c3Linearize(p[0]!, [], cache));

  // merge: [classId] + merge(parent linearizations, direct parents list)
  const merged = c3Merge(parentLinearizations, parents.map((p) => [p[0]!]));
  const result = [classId, ...merged];
  cache.set(classId, result);
  return result;
}

/**
 * C3 merge operation: repeatedly select the first element of the first
 * list that is not in the tail of any other list.
 */
function c3Merge(lists: string[][], parentLists: string[][]): string[] {
  // Build working lists: flatten parent lists
  const working = lists.map((l) => [...l]);

  const result: string[] = [];
  const allLists = [parentLists.flat(), ...working.map((l) => l.slice(1))];

  while (working.some((l) => l.length > 0)) {
    let found = false;

    for (const list of working) {
      if (list.length === 0) continue;
      const head = list[0];

      // Check if head appears in any tail of other lists
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
  dependencies: [],

  execute(context: PhaseContext): MroOutput {
    const { graph } = context;

    const parentMap = buildParentMap(graph);
    const classNodes = findClassNodes(graph);

    const cache = new Map<string, string[]>();
    let extendsEdgeCount = 0;
    let maxDepth = 0;
    let methodEdgeCount = 0;

    // Compute MRO for each class
    for (const cls of classNodes) {
      const parentIds = parentMap.get(cls.id) ?? [];
      extendsEdgeCount += parentIds.length;

      if (parentIds.length > 0) {
        const mro = c3Linearize(cls.id, parentIds.map((id) => [id]), cache);

        const depth = mro.length - 1; // Exclude self
        if (depth > maxDepth) maxDepth = depth;

        // Store MRO as node property
        cls.properties.mro = mro;
        cls.properties.mroDepth = depth;

        // Create HAS_METHOD edges for inherited methods
        // For each ancestor in MRO (excluding self), link to its methods
        for (const ancestorId of mro.slice(1)) {
          const ancestor = graph.getNode(ancestorId);
          if (!ancestor) continue;

          // Find methods defined directly on ancestor
          for (const node of graph.iterNodes()) {
            if (node.label === 'Method' && node.properties.filePath === ancestor.properties.filePath) {
              const edgeId = `mro:${cls.id}:has_method:${node.id}`;
              if (!graph.getRelationship(edgeId)) {
                graph.addRelationship({
                  id: edgeId,
                  sourceId: cls.id,
                  targetId: node.id,
                  type: 'HAS_METHOD',
                  confidence: 0.9,
                  reason: `MRO: ${cls.properties.name} inherits ${node.properties.name} from ${ancestor.properties.name}`,
                });
                methodEdgeCount++;
              }
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
