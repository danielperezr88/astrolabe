/**
 * Tests for API-Aware MCP Tools (#270) — route_map, tool_map, api_impact, shape_check.
 */
import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import { routeMap, toolMap, apiImpact, shapeCheck } from '../../src/mcp/api-tools.js';

function makeTestGraph() {
  const g = createKnowledgeGraph();

  // Files
  g.addNode({ id: 'file:routes/users.ts', label: 'File', properties: { name: 'users.ts', filePath: 'routes/users.ts' } });
  g.addNode({ id: 'file:routes/auth.ts', label: 'File', properties: { name: 'auth.ts', filePath: 'routes/auth.ts' } });
  g.addNode({ id: 'file:tools/db.ts', label: 'File', properties: { name: 'db.ts', filePath: 'tools/db.ts' } });

  // Route nodes
  g.addNode({ id: 'route:users:GET:/api/users', label: 'Route', properties: { name: 'GET /api/users', method: 'GET', path: '/api/users', filePath: 'routes/users.ts' } });
  g.addNode({ id: 'route:auth:POST:/api/login', label: 'Route', properties: { name: 'POST /api/login', method: 'POST', path: '/api/login', filePath: 'routes/auth.ts' } });

  // Tool nodes
  g.addNode({ id: 'tool:db:query', label: 'Tool', properties: { name: 'db_query', toolType: 'mcp', filePath: 'tools/db.ts' } });

  // Handler functions
  g.addNode({ id: 'Function:routes/users.ts:getUsers:L10', label: 'Function', properties: { name: 'getUsers', filePath: 'routes/users.ts', startLine: 10, isExported: true } });
  g.addNode({ id: 'Function:routes/auth.ts:login:L20', label: 'Function', properties: { name: 'login', filePath: 'routes/auth.ts', startLine: 20, isExported: true } });
  g.addNode({ id: 'Function:tools/db.ts:queryDb:L5', label: 'Function', properties: { name: 'queryDb', filePath: 'tools/db.ts', startLine: 5, isExported: true } });
  g.addNode({ id: 'Function:src/app.ts:consume:L1', label: 'Function', properties: { name: 'consumeUsers', filePath: 'src/app.ts', startLine: 1, isExported: false } });

  // HANDLES_ROUTE edges
  g.addRelationship({ id: 'hr:1', sourceId: 'Function:routes/users.ts:getUsers:L10', targetId: 'route:users:GET:/api/users', type: 'HANDLES_ROUTE', confidence: 1, reason: 'handler' });
  g.addRelationship({ id: 'hr:2', sourceId: 'Function:routes/auth.ts:login:L20', targetId: 'route:auth:POST:/api/login', type: 'HANDLES_ROUTE', confidence: 1, reason: 'handler' });

  // HANDLES_TOOL edge
  g.addRelationship({ id: 'ht:1', sourceId: 'Function:tools/db.ts:queryDb:L5', targetId: 'tool:db:query', type: 'HANDLES_TOOL', confidence: 1, reason: 'handler' });

  // CALLS edges (consumer relationships)
  g.addRelationship({ id: 'call:1', sourceId: 'Function:src/app.ts:consume:L1', targetId: 'Function:routes/users.ts:getUsers:L10', type: 'CALLS', confidence: 0.8, reason: 'consumes' });

  return g;
}

describe('API Tools (#270)', () => {
  describe('routeMap', () => {
    it('returns all routes with handlers', () => {
      const map = routeMap(makeTestGraph());
      expect(map.length).toBe(2);
      expect(map.find((r) => r.path === '/api/users')).toBeDefined();
      expect(map.find((r) => r.path === '/api/login')).toBeDefined();
    });

    it('marks route as orphaned when handler not found', () => {
      const g = createKnowledgeGraph();
      g.addNode({ id: 'route:orphan', label: 'Route', properties: { name: 'GET /orphan', method: 'GET', path: '/orphan' } });
      // No HANDLES_ROUTE edge for orphan route
      const map = routeMap(g);
      const orphan = map.find((r) => r.path === '/orphan');
      expect(orphan).toBeDefined();
      expect(orphan!.isOrphaned).toBe(true);
    });

    it('handles empty graph', () => {
      const g = createKnowledgeGraph();
      const map = routeMap(g);
      expect(map).toEqual([]);
    });
  });

  describe('toolMap', () => {
    it('returns all tools with handlers', () => {
      const map = toolMap(makeTestGraph());
      expect(map.length).toBe(1);
      expect(map[0].toolName).toBe('db_query');
      expect(map[0].toolType).toBe('mcp');
    });

    it('marks tool as unused when no callers', () => {
      const map = toolMap(makeTestGraph());
      expect(map[0].isUnused).toBe(true); // no CALLS to queryDb
    });

    it('finds callers for a tool', () => {
      const g = makeTestGraph();
      // Add a caller for the tool handler
      g.addNode({ id: 'Function:src/caller.ts:useDb:L1', label: 'Function', properties: { name: 'useDb', filePath: 'src/caller.ts', startLine: 1 } });
      g.addRelationship({ id: 'call:2', sourceId: 'Function:src/caller.ts:useDb:L1', targetId: 'Function:tools/db.ts:queryDb:L5', type: 'CALLS', confidence: 0.8, reason: 'calls' });
      const map = toolMap(g);
      expect(map[0].isUnused).toBe(false);
      expect(map[0].callers.length).toBe(1);
    });

    it('handles empty graph', () => {
      const g = createKnowledgeGraph();
      const map = toolMap(g);
      expect(map).toEqual([]);
    });
  });

  describe('apiImpact', () => {
    it('finds routes connected to a symbol', () => {
      const impact = apiImpact(makeTestGraph(), 'getUsers');
      expect(impact.length).toBe(1);
      expect(impact[0].routes.length).toBe(1);
      expect(impact[0].routes[0].path).toBe('/api/users');
    });

    it('returns empty array for unknown symbol', () => {
      const impact = apiImpact(makeTestGraph(), 'nonexistent');
      expect(impact).toEqual([]);
    });

    it('#335: returns results for all matching symbols with same name', () => {
      const g = makeTestGraph();
      // Add a second function with same name in different file
      g.addNode({ id: 'Function:routes/v2/users.ts:getUsers:L5', label: 'Function', properties: { name: 'getUsers', filePath: 'routes/v2/users.ts', startLine: 5 } });
      g.addNode({ id: 'route:v2:GET:/api/v2/users', label: 'Route', properties: { name: 'GET /api/v2/users', method: 'GET', path: '/api/v2/users', filePath: 'routes/v2/users.ts' } });
      g.addRelationship({ id: 'hr:3', sourceId: 'Function:routes/v2/users.ts:getUsers:L5', targetId: 'route:v2:GET:/api/v2/users', type: 'HANDLES_ROUTE', confidence: 1, reason: 'handler' });

      const impact = apiImpact(g, 'getUsers');
      expect(impact.length).toBe(2); // both getUsers functions found
    });

    it('detects breaking risk when symbol has consumers', () => {
      const impact = apiImpact(makeTestGraph(), 'getUsers');
      expect(impact[0].routes[0].risk).toBe('BREAKING: has consumers');
      expect(impact[0].routes[0].consumers).toContain('consumeUsers');
    });

    it('handles empty graph', () => {
      const g = createKnowledgeGraph();
      const impact = apiImpact(g, 'anything');
      expect(impact).toEqual([]);
    });
  });

  describe('shapeCheck', () => {
    it('returns empty when no routes or tools match', () => {
      const g = createKnowledgeGraph();
      const shape = shapeCheck(g, 'nonexistent');
      expect(shape).toEqual([]);
    });

    it('returns shape drift for a known route', () => {
      const shape = shapeCheck(makeTestGraph(), 'getUsers');
      // shapeCheck currently is a stub (requires type annotation analysis)
      expect(Array.isArray(shape)).toBe(true);
    });
  });
});
