/**
 * Astrolabe — KnowledgeGraph implementation.
 *
 * Mutable in-memory property graph backed by Maps for O(1) CRUD.
 * Maintains a per-type relationship index for efficient filtered iteration
 * (used heavily by community detection, MRO resolution, etc.).
 */

import type { RelationshipType, KnowledgeGraph, GraphNode, GraphRelationship } from '@astrolabe/shared';

// ── Factory ────────────────────────────────────────────────────────────────

export function createKnowledgeGraph(): KnowledgeGraph {
  const nodeMap = new Map<string, GraphNode>();
  const relMap = new Map<string, GraphRelationship>();

  /**
   * Per-type relationship index.
   * Maps RelationshipType → Set of relationship IDs for O(1) filtered iteration.
   * Kept in sync by addRelationship / removeRelationship.
   */
  const relTypeIndex = new Map<RelationshipType, Set<string>>();

  // ── Internal helpers ──────────────────────────────────────────────────

  function indexRelByType(rel: GraphRelationship): void {
    let bucket = relTypeIndex.get(rel.type);
    if (!bucket) {
      bucket = new Set();
      relTypeIndex.set(rel.type, bucket);
    }
    bucket.add(rel.id);
  }

  function unindexRelByType(rel: GraphRelationship): void {
    const bucket = relTypeIndex.get(rel.type);
    bucket?.delete(rel.id);
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    // ── Getters (materialized arrays — use iterators for hot paths) ────
    get nodes() {
      return Array.from(nodeMap.values());
    },
    get relationships() {
      return Array.from(relMap.values());
    },

    // ── Count (O(1)) ───────────────────────────────────────────────────
    get nodeCount() {
      return nodeMap.size;
    },
    get relationshipCount() {
      return relMap.size;
    },

    // ── Iteration ──────────────────────────────────────────────────────
    iterNodes: () => nodeMap.values(),
    iterRelationships: () => relMap.values(),

    *iterRelationshipsByType(type: RelationshipType): IterableIterator<GraphRelationship> {
      const bucket = relTypeIndex.get(type);
      if (!bucket) return;
      for (const relId of bucket) {
        const rel = relMap.get(relId);
        if (rel) yield rel;
      }
    },

    forEachNode(fn: (node: GraphNode) => void): void {
      nodeMap.forEach(fn);
    },

    forEachRelationship(fn: (rel: GraphRelationship) => void): void {
      relMap.forEach(fn);
    },

    // ── Lookup ─────────────────────────────────────────────────────────
    getNode: (id: string) => nodeMap.get(id),
    getRelationship: (id: string) => relMap.get(id),

    // ── Mutation ───────────────────────────────────────────────────────
    addNode(node: GraphNode): void {
      if (!nodeMap.has(node.id)) {
        nodeMap.set(node.id, node);
      }
    },

    addRelationship(rel: GraphRelationship): void {
      if (!relMap.has(rel.id)) {
        relMap.set(rel.id, rel);
        indexRelByType(rel);
      }
    },

    removeNode(nodeId: string): boolean {
      if (!nodeMap.has(nodeId)) return false;

      // Remove all relationships involving this node
      const toRemove: string[] = [];
      for (const [relId, rel] of relMap) {
        if (rel.sourceId === nodeId || rel.targetId === nodeId) {
          toRemove.push(relId);
          unindexRelByType(rel);
        }
      }
      for (const relId of toRemove) {
        relMap.delete(relId);
      }

      nodeMap.delete(nodeId);
      return true;
    },

    removeNodesByFile(filePath: string): number {
      let removed = 0;
      for (const [nodeId, node] of nodeMap) {
        if (node.properties.filePath === filePath) {
          this.removeNode(nodeId);
          removed++;
        }
      }
      return removed;
    },

    removeRelationship(relId: string): boolean {
      const rel = relMap.get(relId);
      if (!rel) return false;
      unindexRelByType(rel);
      relMap.delete(relId);
      return true;
    },
  };
}
