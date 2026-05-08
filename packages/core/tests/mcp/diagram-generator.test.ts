/**
 * Tests for the Mermaid diagram generator.
 */

import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import { generateDiagram, generateMarkdownDoc } from '../../src/mcp/diagram-generator.js';
import type { GraphNode, GraphRelationship } from '../../src/core/types.js';

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return { label: 'Function', properties: {}, ...overrides };
}

function makeRel(overrides: Partial<GraphRelationship> & { id: string; sourceId: string; targetId: string }): GraphRelationship {
  return { type: 'CALLS', confidence: 1.0, reason: 'test', ...overrides };
}

// ── Helper: build a small realistic graph ───────────────────────────────────

function buildTestGraph() {
  const g = createKnowledgeGraph();

  // Communities
  g.addNode(makeNode({ id: 'community:1', label: 'Community', properties: { name: 'auth-module', symbolCount: 3, cohesion: 0.85 } }));
  g.addNode(makeNode({ id: 'community:2', label: 'Community', properties: { name: 'db-layer', symbolCount: 2, cohesion: 0.72 } }));

  // Members of community 1
  g.addNode(makeNode({ id: 'fn:auth:login', label: 'Function', properties: { name: 'login', filePath: 'src/auth/login.ts', startLine: 10 } }));
  g.addNode(makeNode({ id: 'fn:auth:validate', label: 'Function', properties: { name: 'validateToken', filePath: 'src/auth/validate.ts', startLine: 5 } }));
  g.addNode(makeNode({ id: 'cls:auth:handler', label: 'Class', properties: { name: 'AuthHandler', filePath: 'src/auth/handler.ts', startLine: 1 } }));

  // Members of community 2
  g.addNode(makeNode({ id: 'fn:db:query', label: 'Function', properties: { name: 'query', filePath: 'src/db/query.ts', startLine: 20 } }));
  g.addNode(makeNode({ id: 'cls:db:repo', label: 'Class', properties: { name: 'UserRepo', filePath: 'src/db/repo.ts', startLine: 1 } }));

  // Interfaces and implementations for class hierarchy
  g.addNode(makeNode({ id: 'iface:auth:provider', label: 'Interface', properties: { name: 'AuthProvider', filePath: 'src/auth/provider.ts', startLine: 3 } }));
  g.addNode(makeNode({ id: 'cls:auth:impl', label: 'Class', properties: { name: 'OAuthProvider', filePath: 'src/auth/oauth.ts', startLine: 1 } }));

  // MEMBER_OF edges
  g.addRelationship(makeRel({ id: 'mem:1', sourceId: 'fn:auth:login', targetId: 'community:1', type: 'MEMBER_OF', confidence: 0.7 }));
  g.addRelationship(makeRel({ id: 'mem:2', sourceId: 'fn:auth:validate', targetId: 'community:1', type: 'MEMBER_OF', confidence: 0.7 }));
  g.addRelationship(makeRel({ id: 'mem:3', sourceId: 'cls:auth:handler', targetId: 'community:1', type: 'MEMBER_OF', confidence: 0.7 }));
  g.addRelationship(makeRel({ id: 'mem:4', sourceId: 'fn:db:query', targetId: 'community:2', type: 'MEMBER_OF', confidence: 0.7 }));
  g.addRelationship(makeRel({ id: 'mem:5', sourceId: 'cls:db:repo', targetId: 'community:2', type: 'MEMBER_OF', confidence: 0.7 }));

  // Coupling edges
  g.addRelationship(makeRel({ id: 'call:1', sourceId: 'fn:auth:login', targetId: 'fn:auth:validate', type: 'CALLS', confidence: 0.9 }));
  g.addRelationship(makeRel({ id: 'call:2', sourceId: 'cls:auth:handler', targetId: 'fn:auth:login', type: 'CALLS', confidence: 0.8 }));
  g.addRelationship(makeRel({ id: 'call:3', sourceId: 'fn:auth:login', targetId: 'fn:db:query', type: 'CALLS', confidence: 0.85 }));
  g.addRelationship(makeRel({ id: 'call:4', sourceId: 'cls:db:repo', targetId: 'fn:db:query', type: 'CALLS', confidence: 0.9 }));

  // EXTENDS / IMPLEMENTS for class hierarchy
  g.addRelationship(makeRel({ id: 'ext:1', sourceId: 'cls:auth:impl', targetId: 'iface:auth:provider', type: 'IMPLEMENTS', confidence: 0.95 }));
  g.addRelationship(makeRel({ id: 'ext:2', sourceId: 'cls:auth:handler', targetId: 'cls:auth:impl', type: 'EXTENDS', confidence: 0.8 }));

  // Process
  g.addNode(makeNode({ id: 'process:login_flow', label: 'Process', properties: { name: 'login-flow', entryPointId: 'fn:auth:login', stepCount: 3, processType: 'cross_community' } }));

  // STEP_IN_PROCESS edges
  g.addRelationship(makeRel({ id: 'step:1', sourceId: 'process:login_flow', targetId: 'fn:auth:login', type: 'STEP_IN_PROCESS', step: 1, confidence: 1.0 }));
  g.addRelationship(makeRel({ id: 'step:2', sourceId: 'process:login_flow', targetId: 'fn:auth:validate', type: 'STEP_IN_PROCESS', step: 2, confidence: 1.0 }));
  g.addRelationship(makeRel({ id: 'step:3', sourceId: 'process:login_flow', targetId: 'fn:db:query', type: 'STEP_IN_PROCESS', step: 3, confidence: 1.0 }));

  // ENTRY_POINT_OF
  g.addRelationship(makeRel({ id: 'ep:1', sourceId: 'fn:auth:login', targetId: 'process:login_flow', type: 'ENTRY_POINT_OF', confidence: 0.9 }));

  return g;
}

describe('diagram-generator', () => {
  // ── Community Diagram ──────────────────────────────────────────────────
  describe('community diagram', () => {
    it('produces Mermaid syntax with subgraphs', () => {
      const g = buildTestGraph();
      const result = generateDiagram(g, { type: 'community' });

      expect(result.format).toBe('mermaid');
      expect(result.diagram).toContain('```mermaid');
      expect(result.diagram).toContain('graph TD');
      expect(result.diagram).toContain('subgraph');
      expect(result.diagram).toContain('auth-module');
      expect(result.diagram).toContain('db-layer');
      expect(result.diagram).toContain('-->');
      expect(result.stats.nodeCount).toBeGreaterThan(0);
      expect(result.stats.edgeCount).toBeGreaterThan(0);
    });

    it('filters by cluster_id', () => {
      const g = buildTestGraph();
      const result = generateDiagram(g, { type: 'community', clusterId: 'community:1' });

      expect(result.diagram).toContain('auth-module');
      // Should focus on community:1 and connected communities
      expect(result.diagram).toContain('subgraph');
    });

    it('handles empty graph gracefully', () => {
      const g = createKnowledgeGraph();
      const result = generateDiagram(g, { type: 'community' });

      expect(result.diagram).toContain('```mermaid');
      expect(result.diagram).toContain('%% No communities detected');
      expect(result.stats.nodeCount).toBe(0);
    });
  });

  // ── Process Diagram ────────────────────────────────────────────────────
  describe('process diagram', () => {
    it('produces Mermaid flow for login process', () => {
      const g = buildTestGraph();
      const result = generateDiagram(g, { type: 'process', processId: 'process:login_flow' });

      expect(result.diagram).toContain('```mermaid');
      expect(result.diagram).toContain('graph LR');
      expect(result.diagram).toContain('login');
      expect(result.diagram).toContain('validateToken');
      expect(result.diagram).toContain('query');
      expect(result.diagram).toContain('-->|"step ');
      expect(result.stats.nodeCount).toBeGreaterThan(0);
    });

    it('shows all processes when no processId given', () => {
      const g = buildTestGraph();
      const result = generateDiagram(g, { type: 'process' });

      expect(result.diagram).toContain('```mermaid');
      expect(result.diagram).toContain('login-flow');
    });

    it('handles no processes gracefully', () => {
      const g = createKnowledgeGraph();
      const result = generateDiagram(g, { type: 'process' });

      expect(result.diagram).toContain('No process data available');
    });
  });

  // ── Dependency Diagram ─────────────────────────────────────────────────
  describe('dependency diagram', () => {
    it('produces Mermaid graph of coupling edges', () => {
      const g = buildTestGraph();
      const result = generateDiagram(g, { type: 'dependency' });

      expect(result.diagram).toContain('```mermaid');
      expect(result.diagram).toContain('graph TD');
      expect(result.diagram).toContain('-->');
      expect(result.diagram).toContain('login');
      expect(result.diagram).toContain('validateToken');
    });

    it('respects max_nodes limit', () => {
      const g = buildTestGraph();
      const result = generateDiagram(g, { type: 'dependency', maxNodes: 2 });

      expect(result.stats.nodeCount).toBeLessThanOrEqual(2);
    });

    it('respects min_confidence threshold', () => {
      const g = buildTestGraph();

      // Add a low-confidence edge
      g.addNode(makeNode({ id: 'fn:low:conf', label: 'Function', properties: { name: 'lowConf' } }));
      g.addRelationship(makeRel({ id: 'lc:1', sourceId: 'fn:auth:login', targetId: 'fn:low:conf', type: 'CALLS', confidence: 0.2 }));

      // With high threshold, low-confidence edge should be excluded
      const result = generateDiagram(g, { type: 'dependency', minConfidence: 0.8 });
      expect(result.diagram).not.toContain('lowConf');
    });

    it('handles no edges gracefully', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'a', label: 'Function', properties: { name: 'lonely' } }));
      const result = generateDiagram(g, { type: 'dependency' });

      expect(result.diagram).toContain('No coupling edges found');
    });
  });

  // ── Class Hierarchy Diagram ────────────────────────────────────────────
  describe('class hierarchy diagram', () => {
    it('produces Mermaid graph of EXTENDS/IMPLEMENTS', () => {
      const g = buildTestGraph();
      const result = generateDiagram(g, { type: 'class_hierarchy' });

      expect(result.diagram).toContain('```mermaid');
      expect(result.diagram).toContain('graph TD');
      expect(result.diagram).toContain('OAuthProvider');
      expect(result.diagram).toContain('AuthProvider');
      expect(result.diagram).toContain('AuthHandler');
      expect(result.diagram).toContain('==>');
    });

    it('handles no hierarchy gracefully', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'cls:a', label: 'Class', properties: { name: 'LonelyClass' } }));
      const result = generateDiagram(g, { type: 'class_hierarchy' });

      expect(result.diagram).toContain('No EXTENDS/IMPLEMENTS edges');
    });
  });

  // ── Markdown Format ────────────────────────────────────────────────────
  describe('markdown format', () => {
    it('wraps Mermaid diagram in documentation', () => {
      const g = buildTestGraph();
      const doc = generateMarkdownDoc(g, { type: 'community' }, 'my-repo');

      expect(doc).toContain('# Community Architecture');
      expect(doc).toContain('my-repo');
      expect(doc).toContain('```mermaid');
      expect(doc).toContain('**Stats**');
    });

    it('works without repo name', () => {
      const g = buildTestGraph();
      const doc = generateMarkdownDoc(g, { type: 'dependency' });

      expect(doc).toContain('# Dependency Graph');
      expect(doc).toContain('```mermaid');
    });
  });

  // ── Stats ──────────────────────────────────────────────────────────────
  describe('stats', () => {
    it('includes community and process counts', () => {
      const g = buildTestGraph();
      const result = generateDiagram(g, { type: 'community' });

      expect(result.stats.communityCount).toBe(2);
      expect(result.stats.processCount).toBe(1);
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('sanitizes node IDs with special characters', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'ns:com.example:MyClass', label: 'Class', properties: { name: 'MyClass' } }));
      g.addNode(makeNode({ id: 'ns:com.example:OtherClass', label: 'Class', properties: { name: 'OtherClass' } }));
      g.addRelationship(makeRel({ id: 'r1', sourceId: 'ns:com.example:MyClass', targetId: 'ns:com.example:OtherClass', type: 'EXTENDS' }));

      const result = generateDiagram(g, { type: 'class_hierarchy' });
      expect(result.diagram).not.toContain('ns:com.example:MyClass'); // raw colon-containing ID
      expect(result.diagram).toContain('MyClass'); // sanitized label
    });

    it('sanitizes labels with quotes', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode({ id: 'fn:test', label: 'Function', properties: { name: 'handle "special" case' } }));
      g.addNode(makeNode({ id: 'fn:test2', label: 'Function', properties: { name: 'normal' } }));
      g.addRelationship(makeRel({ id: 'r1', sourceId: 'fn:test', targetId: 'fn:test2', type: 'CALLS' }));

      const result = generateDiagram(g, { type: 'dependency' });
      // The quote should be escaped, not raw
      expect(result.diagram).toContain('\\"special\\"');
    });

    it('truncates very long node names', () => {
      const g = createKnowledgeGraph();
      const longName = 'a'.repeat(60);
      g.addNode(makeNode({ id: 'fn:long', label: 'Function', properties: { name: longName } }));
      g.addNode(makeNode({ id: 'fn:short', label: 'Function', properties: { name: 'b' } }));
      g.addRelationship(makeRel({ id: 'r1', sourceId: 'fn:long', targetId: 'fn:short', type: 'CALLS' }));

      const result = generateDiagram(g, { type: 'dependency' });
      expect(result.diagram).toContain('...');
    });
  });
});
