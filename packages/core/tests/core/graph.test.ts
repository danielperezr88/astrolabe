/**
 * Tests for the KnowledgeGraph implementation.
 */

import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import type { GraphNode, GraphRelationship } from '../../src/core/types.js';

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    label: 'Function',
    properties: {},
    ...overrides,
  };
}

function makeRel(overrides: Partial<GraphRelationship> & { id: string; sourceId: string; targetId: string }): GraphRelationship {
  return {
    type: 'CALLS',
    confidence: 1.0,
    reason: 'test',
    ...overrides,
  };
}

describe('KnowledgeGraph', () => {
  describe('empty graph', () => {
    const g = createKnowledgeGraph();

    it('starts with zero nodes', () => {
      expect(g.nodeCount).toBe(0);
      expect(g.nodes).toEqual([]);
    });

    it('starts with zero relationships', () => {
      expect(g.relationshipCount).toBe(0);
      expect(g.relationships).toEqual([]);
    });

    it('returns undefined for missing node', () => {
      expect(g.getNode('nope')).toBeUndefined();
    });
  });

  describe('addNode', () => {
    it('adds a node and increments count', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'fn:foo:bar', label: 'Function', properties: { name: 'bar' } }));
      expect(g.nodeCount).toBe(1);
      expect(g.getNode('fn:foo:bar')?.properties.name).toBe('bar');
    });

    it('is idempotent (does not overwrite)', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'x', properties: { name: 'first' } }));
      g.addNode(makeNode({ id: 'x', properties: { name: 'second' } }));
      expect(g.nodeCount).toBe(1);
      expect(g.getNode('x')?.properties.name).toBe('first');
    });

    it('shows up in iterNodes and forEachNode', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'a' }));
      g.addNode(makeNode({ id: 'b' }));

      const ids = new Set<string>();
      for (const n of g.iterNodes()) ids.add(n.id);
      expect(ids).toEqual(new Set(['a', 'b']));

      const ids2 = new Set<string>();
      g.forEachNode((n) => ids2.add(n.id));
      expect(ids2).toEqual(new Set(['a', 'b']));
    });
  });

  describe('addRelationship', () => {
    it('adds a relationship and maintains per-type index', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'a' }));
      g.addNode(makeNode({ id: 'b' }));
      g.addRelationship(makeRel({ id: 'r1', sourceId: 'a', targetId: 'b', type: 'CALLS' }));

      expect(g.relationshipCount).toBe(1);

      // iterRelationshipsByType should find it
      const calls = Array.from(g.iterRelationshipsByType('CALLS'));
      expect(calls).toHaveLength(1);
      expect(calls[0].id).toBe('r1');

      // Other type should return empty
      expect(Array.from(g.iterRelationshipsByType('IMPORTS'))).toHaveLength(0);
    });

    it('supports multiple relationship types', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'a' }));
      g.addNode(makeNode({ id: 'b' }));
      g.addNode(makeNode({ id: 'c' }));
      g.addRelationship(makeRel({ id: 'r1', sourceId: 'a', targetId: 'b', type: 'CALLS' }));
      g.addRelationship(makeRel({ id: 'r2', sourceId: 'a', targetId: 'c', type: 'IMPORTS' }));

      expect(Array.from(g.iterRelationshipsByType('CALLS'))).toHaveLength(1);
      expect(Array.from(g.iterRelationshipsByType('IMPORTS'))).toHaveLength(1);
    });
  });

  describe('removeNode', () => {
    it('removes a node and its relationships', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'a' }));
      g.addNode(makeNode({ id: 'b' }));
      g.addRelationship(makeRel({ id: 'r1', sourceId: 'a', targetId: 'b', type: 'CALLS' }));

      expect(g.removeNode('a')).toBe(true);
      expect(g.nodeCount).toBe(1);
      expect(g.relationshipCount).toBe(0);
      expect(g.getNode('a')).toBeUndefined();
    });

    it('returns false for non-existent node', () => {
      const g = createKnowledgeGraph();
      expect(g.removeNode('nope')).toBe(false);
    });
  });

  describe('removeNodesByFile', () => {
    it('removes all nodes in a file', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'a', properties: { filePath: 'src/foo.ts' } }));
      g.addNode(makeNode({ id: 'b', properties: { filePath: 'src/foo.ts' } }));
      g.addNode(makeNode({ id: 'c', properties: { filePath: 'src/bar.ts' } }));

      expect(g.removeNodesByFile('src/foo.ts')).toBe(2);
      expect(g.nodeCount).toBe(1);
      expect(g.getNode('c')).toBeDefined();
    });
  });

  describe('removeRelationship', () => {
    it('removes a single relationship and cleans up type index', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'a' }));
      g.addNode(makeNode({ id: 'b' }));
      g.addRelationship(makeRel({ id: 'r1', sourceId: 'a', targetId: 'b', type: 'CALLS' }));

      expect(g.removeRelationship('r1')).toBe(true);
      expect(g.relationshipCount).toBe(0);
      expect(Array.from(g.iterRelationshipsByType('CALLS'))).toHaveLength(0);
    });
  });

  describe('materialized arrays', () => {
    it('.nodes and .relationships return snapshots', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'a' }));
      const snapshot = g.nodes;
      g.addNode(makeNode({ id: 'b' }));
      expect(snapshot).toHaveLength(1); // snapshot frozen at call time
      expect(g.nodes).toHaveLength(2);  // current state
    });
  });
});
