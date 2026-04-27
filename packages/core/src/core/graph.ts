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

  /**
   * Per-file reverse index for O(1) bulk-remove.
   * Maps filePath → Set of node IDs belonging to that file.
   */
  const fileIndex = new Map<string, Set<string>>();

  /** Node-to-relationship reverse index for O(1) removeNode (#156). */
  const nodeRelIndex = new Map<string, Set<string>>();

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

    findNodesByLabel(label: string): GraphNode[] {
      const result: GraphNode[] = [];
      for (const node of nodeMap.values()) {
        if (node.label === label) result.push(node);
      }
      return result;
    },

    findNodesByProperty(key: string, value: unknown): GraphNode[] {
      const result: GraphNode[] = [];
      for (const node of nodeMap.values()) {
        if (node.properties[key] === value) result.push(node);
      }
      return result;
    },

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
      if (nodeMap.has(node.id)) {
        // Node already exists — update properties to allow idempotent re-adds (#159)
        const existing = nodeMap.get(node.id)!;
        Object.assign(existing.properties, node.properties);
        return;
      }
      nodeMap.set(node.id, node);
      // Maintain per-file index for O(1) removal
      const fp = node.properties.filePath;
      if (fp) {
        let bucket = fileIndex.get(fp);
        if (!bucket) { bucket = new Set(); fileIndex.set(fp, bucket); }
        bucket.add(node.id);
      }
    },

    addRelationship(rel: GraphRelationship): void {
      if (!relMap.has(rel.id)) {
        relMap.set(rel.id, rel);
        indexRelByType(rel);
        // Maintain node-to-rel reverse index (#156)
        for (const nid of [rel.sourceId, rel.targetId]) {
          let bucket = nodeRelIndex.get(nid);
          if (!bucket) { bucket = new Set(); nodeRelIndex.set(nid, bucket); }
          bucket.add(rel.id);
        }
      }
    },

    removeNode(nodeId: string): boolean {
      if (!nodeMap.has(nodeId)) return false;

      const node = nodeMap.get(nodeId)!;
      const fp = node.properties.filePath;
      if (fp) fileIndex.get(fp)?.delete(nodeId);

      // O(1) per relationship using reverse index (#156)
      const relIds = nodeRelIndex.get(nodeId);
      if (relIds) {
        for (const relId of relIds) {
          const rel = relMap.get(relId);
          if (rel) {
            unindexRelByType(rel);
            // Remove from peer node's reverse index too
            const peerId = rel.sourceId === nodeId ? rel.targetId : rel.sourceId;
            nodeRelIndex.get(peerId)?.delete(relId);
          }
          relMap.delete(relId);
        }
        nodeRelIndex.delete(nodeId);
      }

      nodeMap.delete(nodeId);
      return true;
    },

    removeNodesByFile(filePath: string): number {
      const bucket = fileIndex.get(filePath);
      if (!bucket) return 0;
      const ids = Array.from(bucket);
      for (const id of ids) {
        this.removeNode(id);
      }
      fileIndex.delete(filePath);
      return ids.length;
    },

    removeRelationship(relId: string): boolean {
      const rel = relMap.get(relId);
      if (!rel) return false;
      unindexRelByType(rel);
      // Clean up node-to-relationship reverse index (#188)
      for (const nid of [rel.sourceId, rel.targetId]) {
        nodeRelIndex.get(nid)?.delete(relId);
      }
      relMap.delete(relId);
      return true;
    },
  };
}
