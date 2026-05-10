/**
 * Tests for API-Aware MCP Tools (#270) — route_map, tool_map, api_impact, shape_check.
 */
import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import {
  routeMap,
  toolMap,
  apiImpact,
  shapeCheck,
  extractConsumerAccessedFields,
} from '../../src/mcp/api-tools.js';
import type { ShapeMismatch } from '../../src/mcp/api-tools.js';

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

/** Graph with responseKeys and FETCHES edges for testing shape_check with real data */
function makeShapeTestGraph() {
  const g = createKnowledgeGraph();

  // Route with response keys
  g.addNode({
    id: 'route:users:GET:/api/users',
    label: 'Route',
    properties: {
      name: 'GET /api/users',
      method: 'GET',
      path: '/api/users',
      filePath: 'routes/users.ts',
      responseKeys: ['id', 'name', 'email'],
      errorKeys: ['error', 'message'],
    },
  });

  // Route without response keys
  g.addNode({
    id: 'route:auth:POST:/api/login',
    label: 'Route',
    properties: {
      name: 'POST /api/login',
      method: 'POST',
      path: '/api/login',
      filePath: 'routes/auth.ts',
      responseKeys: ['token', 'user'],
    },
  });

  // Consumer function that fetches /api/users
  g.addNode({
    id: 'Function:src/app.ts:consumeUsers:L1',
    label: 'Function',
    properties: {
      name: 'consumeUsers',
      filePath: 'src/app.ts',
      startLine: 1,
      endLine: 10,
    },
  });

  // Consumer that fetches /api/login
  g.addNode({
    id: 'Function:src/app.ts:consumeLogin:L15',
    label: 'Function',
    properties: {
      name: 'consumeLogin',
      filePath: 'src/app.ts',
      startLine: 15,
      endLine: 25,
    },
  });

  // FETCHES edges: consumers → routes
  g.addRelationship({
    id: 'fetch:1',
    sourceId: 'Function:src/app.ts:consumeUsers:L1',
    targetId: 'route:users:GET:/api/users',
    type: 'FETCHES',
    confidence: 0.7,
    reason: 'fetch to /api/users',
  });

  g.addRelationship({
    id: 'fetch:2',
    sourceId: 'Function:src/app.ts:consumeLogin:L15',
    targetId: 'route:auth:POST:/api/login',
    type: 'FETCHES',
    confidence: 0.7,
    reason: 'axios to /api/login',
  });

  return g;
}

// ── Tests ──────────────────────────────────────────────────────────────────

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
      expect(map[0].isUnused).toBe(true);
    });

    it('finds callers for a tool', () => {
      const g = makeTestGraph();
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
    it('finds routes connected to a symbol', async () => {
      const impact = await apiImpact(makeTestGraph(), 'getUsers');
      expect(impact.length).toBe(1);
      expect(impact[0].routes.length).toBe(1);
      expect(impact[0].routes[0].path).toBe('/api/users');
    });

    it('returns empty array for unknown symbol', async () => {
      const impact = await apiImpact(makeTestGraph(), 'nonexistent');
      expect(impact).toEqual([]);
    });

    it('#335: returns results for all matching symbols with same name', async () => {
      const g = makeTestGraph();
      g.addNode({ id: 'Function:routes/v2/users.ts:getUsers:L5', label: 'Function', properties: { name: 'getUsers', filePath: 'routes/v2/users.ts', startLine: 5 } });
      g.addNode({ id: 'route:v2:GET:/api/v2/users', label: 'Route', properties: { name: 'GET /api/v2/users', method: 'GET', path: '/api/v2/users', filePath: 'routes/v2/users.ts' } });
      g.addRelationship({ id: 'hr:3', sourceId: 'Function:routes/v2/users.ts:getUsers:L5', targetId: 'route:v2:GET:/api/v2/users', type: 'HANDLES_ROUTE', confidence: 1, reason: 'handler' });

      const impact = await apiImpact(g, 'getUsers');
      expect(impact.length).toBe(2);
    });

    it('detects breaking risk when symbol has consumers', async () => {
      const impact = await apiImpact(makeTestGraph(), 'getUsers');
      expect(impact[0].routes[0].risk).toBe('BREAKING: has consumers');
      expect(impact[0].routes[0].consumers).toContain('consumeUsers');
    });

    it('handles empty graph', async () => {
      const g = createKnowledgeGraph();
      const impact = await apiImpact(g, 'anything');
      expect(impact).toEqual([]);
    });
  });

  describe('shapeCheck', () => {
    it('returns empty when route not found', async () => {
      const g = createKnowledgeGraph();
      const shape = await shapeCheck(g, 'nonexistent');
      expect(shape).toEqual([]);
    });

    it('returns empty when route has no responseKeys', async () => {
      const g = createKnowledgeGraph();
      g.addNode({ id: 'route:test', label: 'Route', properties: { path: '/test', method: 'GET' } });
      const shape = await shapeCheck(g, '/test');
      expect(shape).toEqual([]);
    });

    it('detects unused fields when route has responseKeys but no consumer access extracted', async () => {
      const g = makeShapeTestGraph();
      // No repoPath → can't read consumer source files → all provider keys flagged as warnings
      const shape = await shapeCheck(g, '/api/users');
      // Without repoPath, provider keys are flagged as warnings
      expect(shape.length).toBeGreaterThan(0);
      for (const m of shape) {
        expect(m).toHaveProperty('field');
        expect(m).toHaveProperty('severity');
        expect(m).toHaveProperty('reason');
      }
    });

    it('returns mismatches with proper ShapeMismatch shape', async () => {
      const g = makeShapeTestGraph();
      const shape = await shapeCheck(g, '/api/login');
      for (const m of shape) {
        expect(typeof m.field).toBe('string');
        expect(['missing', 'unused', 'warning']).toContain(m.severity);
        expect(typeof m.reason).toBe('string');
      }
    });

    it('handles FETCHES consumers with no repoPath gracefully', async () => {
      const g = makeShapeTestGraph();
      const shape = await shapeCheck(g, '/api/users');
      // Should have warnings for provider keys since consumers exist but can't verify access
      const warnings = shape.filter((m: ShapeMismatch) => m.severity === 'warning');
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe('extractConsumerAccessedFields', () => {
    it('extracts dot-access fields on response vars', () => {
      const code = 'const users = data.users; const name = data.name;';
      const fields = extractConsumerAccessedFields(code);
      expect(fields).toContain('users');
      expect(fields).toContain('name');
    });

    it('extracts optional chaining fields', () => {
      const code = 'const id = data?.id; const email = response?.user?.email;';
      const fields = extractConsumerAccessedFields(code);
      expect(fields).toContain('id');
      expect(fields).toContain('user');
    });

    it('extracts bracket-access fields', () => {
      const code = "const role = data['role']; const token = response['access_token'];";
      const fields = extractConsumerAccessedFields(code);
      expect(fields).toContain('role');
      expect(fields).toContain('access_token');
    });

    it('extracts destructured fields', () => {
      const code = 'const { id, name, email } = data;';
      const fields = extractConsumerAccessedFields(code);
      expect(fields).toContain('id');
      expect(fields).toContain('name');
      expect(fields).toContain('email');
    });

    it('extracts destructured fields from await response', () => {
      const code = 'const { token } = await response;';
      const fields = extractConsumerAccessedFields(code);
      expect(fields).toContain('token');
    });

    it('deduplicates fields', () => {
      const code = 'data.name; data.name; data.email;';
      const fields = extractConsumerAccessedFields(code);
      expect(fields.filter((f) => f === 'name').length).toBe(1);
    });

    it('ignores non-response var dot access', () => {
      const code = 'user.name; config.host; foo.bar;';
      const fields = extractConsumerAccessedFields(code);
      expect(fields).not.toContain('name');
      expect(fields).not.toContain('host');
      expect(fields).not.toContain('bar');
    });

    it('handles empty code', () => {
      const fields = extractConsumerAccessedFields('');
      expect(fields).toEqual([]);
    });
  });
});
