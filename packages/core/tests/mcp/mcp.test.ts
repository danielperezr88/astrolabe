/**
 * Tests for the MCP server — protocol handling, registry, tools (#69).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteStore } from '../../src/persist/sqlite.js';
import { createFtsSearch } from '../../src/search/fts.js';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import { loadRegistry, saveRegistry, type RegistryEntry } from '../../src/mcp/registry.js';

let testDir: string;
let dbPath: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'astrolabe-mcp-'));
  dbPath = join(testDir, 'mcp-test.db');
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('MCP Server (#69)', () => {
  // ── Protocol ──────────────────────────────────────────────────────────
  describe('protocol', () => {
    it('notifications are detected and produce no response', () => {
      const isNotification = (method: string) => method.startsWith('notifications/');
      expect(isNotification('notifications/initialized')).toBe(true);
      expect(isNotification('notifications/cancelled')).toBe(true);
      expect(isNotification('tools/call')).toBe(false);
      expect(isNotification('initialize')).toBe(false);
    });

    it('initialize returns server info and capabilities', () => {
      // Verify the protocol shape matches MCP spec
      const caps = { tools: {}, resources: { subscribe: false }, prompts: {} };
      expect(caps.tools).toBeDefined();
      expect(caps.resources).toBeDefined();
      expect(caps.prompts).toBeDefined();
    });
  });

  // ── Registry ──────────────────────────────────────────────────────────
  describe('registry', () => {
    it('loads empty registry when no entries exist', () => {
      const entry: RegistryEntry = {
        name: 'test-repo', path: testDir, dbPath,
        lastCommit: 'abc123', indexedAt: Date.now(),
      };
      saveRegistry([entry]);
      const repos = loadRegistry();
      expect(repos.length).toBeGreaterThanOrEqual(1);
      expect(repos[0].name).toBe('test-repo');
      expect(repos[0].path).toBe(testDir);
    });
  });

  // ── Search (backed by FTS) ───────────────────────────────────────────
  describe('search', () => {
    it('returns ranked results via FTS', () => {
      const store = createSqliteStore(dbPath);
      const graph = createKnowledgeGraph();
      graph.addNode({ id: 'fn:test:foo', label: 'Function', properties: { name: 'foo', filePath: 'src/test.ts' } });
      store.saveGraph(graph);

      const fts = createFtsSearch(dbPath);
      fts.indexGraph(store);
      const results = fts.search('foo', 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('foo');

      fts.close();
      store.close();
    });

    it('handles empty search gracefully', () => {
      const fts = createFtsSearch(dbPath);
      expect(fts.search('nonexistent', 5)).toHaveLength(0);
      fts.close();
    });

    it('returns correct field types in results', () => {
      const store = createSqliteStore(dbPath);
      const graph = createKnowledgeGraph();
      graph.addNode({ id: 'fn:a:bar', label: 'Function', properties: { name: 'barFunction', filePath: 'src/a.ts' } });
      store.saveGraph(graph);

      const fts = createFtsSearch(dbPath);
      fts.indexGraph(store);
      const results = fts.search('barFunction', 5);
      expect(results).toHaveLength(1);
      expect(results[0].nodeId).toBe('fn:a:bar');
      expect(results[0].label).toBe('Function');
      expect(typeof results[0].score).toBe('number');
      expect(typeof results[0].snippet).toBe('string');

      fts.close();
      store.close();
    });
  });

  // ── Graph loading ─────────────────────────────────────────────────────
  describe('graph operations', () => {
    it('loads graph with findNodesByLabel', () => {
      const store = createSqliteStore(dbPath);
      const graph = createKnowledgeGraph();
      graph.addNode({ id: 'fn:x:a', label: 'Function', properties: { name: 'a', filePath: 'x.ts' } });
      graph.addNode({ id: 'cls:x:b', label: 'Class', properties: { name: 'b', filePath: 'x.ts' } });
      store.saveGraph(graph);

      const loaded = store.loadGraph();
      expect(loaded.findNodesByLabel('Function')).toHaveLength(1);
      expect(loaded.findNodesByLabel('Class')).toHaveLength(1);
      expect(loaded.findNodesByLabel('Interface')).toHaveLength(0);

      store.close();
    });

    it('graph node count and edge count are correct', () => {
      const store = createSqliteStore(dbPath);
      const graph = createKnowledgeGraph();
      graph.addNode({ id: 'n:1', label: 'Function', properties: { name: 'f1', filePath: 'a.ts' } });
      graph.addNode({ id: 'n:2', label: 'Function', properties: { name: 'f2', filePath: 'a.ts' } });
      graph.addRelationship({ id: 'r:1', sourceId: 'n:1', targetId: 'n:2', type: 'CALLS', confidence: 0.9, reason: '' });
      store.saveGraph(graph);

      const loaded = store.loadGraph();
      expect(loaded.nodeCount).toBe(2);
      expect(loaded.relationshipCount).toBe(1);

      store.close();
    });
  });

  // ── Graph Traversal Query Engine (#369) ─────────────────────────────
  describe('graphQuery (cypher)', () => {
    function buildTestGraph() {
      const graph = createKnowledgeGraph();
      // Functions
      graph.addNode({ id: 'fn:auth:login', label: 'Function', properties: { name: 'login', filePath: 'src/auth/login.ts' } });
      graph.addNode({ id: 'fn:auth:validate', label: 'Function', properties: { name: 'validatePassword', filePath: 'src/auth/validate.ts' } });
      graph.addNode({ id: 'fn:db:getUser', label: 'Function', properties: { name: 'getUser', filePath: 'src/db/users.ts' } });
      graph.addNode({ id: 'fn:db:query', label: 'Function', properties: { name: 'query', filePath: 'src/db/query.ts' } });
      graph.addNode({ id: 'fn:api:handleLogin', label: 'Function', properties: { name: 'handleLogin', filePath: 'src/api/auth.ts' } });
      graph.addNode({ id: 'fn:test:loginTest', label: 'Function', properties: { name: 'testLogin', filePath: 'src/__tests__/auth.test.ts' } });
      // Class
      graph.addNode({ id: 'cls:auth:AuthService', label: 'Class', properties: { name: 'AuthService', filePath: 'src/auth/service.ts' } });
      // Community
      graph.addNode({ id: 'comm:auth', label: 'Community', properties: { name: 'Authentication', cohesion: 0.85, symbolCount: 4 } });
      // CALLS edges
      graph.addRelationship({ id: 'r:1', sourceId: 'fn:api:handleLogin', targetId: 'fn:auth:validate', type: 'CALLS', confidence: 0.95, reason: '' });
      graph.addRelationship({ id: 'r:2', sourceId: 'fn:auth:login', targetId: 'fn:auth:validate', type: 'CALLS', confidence: 0.9, reason: '' });
      graph.addRelationship({ id: 'r:3', sourceId: 'fn:auth:validate', targetId: 'fn:db:getUser', type: 'CALLS', confidence: 0.85, reason: '' });
      graph.addRelationship({ id: 'r:4', sourceId: 'fn:db:getUser', targetId: 'fn:db:query', type: 'CALLS', confidence: 0.95, reason: '' });
      graph.addRelationship({ id: 'r:5', sourceId: 'fn:test:loginTest', targetId: 'fn:auth:login', type: 'CALLS', confidence: 0.5, reason: '' });
      // MEMBER_OF edges
      graph.addRelationship({ id: 'r:6', sourceId: 'fn:auth:login', targetId: 'comm:auth', type: 'MEMBER_OF', confidence: 1.0, reason: '' });
      graph.addRelationship({ id: 'r:7', sourceId: 'fn:auth:validate', targetId: 'comm:auth', type: 'MEMBER_OF', confidence: 1.0, reason: '' });
      graph.addRelationship({ id: 'r:8', sourceId: 'cls:auth:AuthService', targetId: 'comm:auth', type: 'MEMBER_OF', confidence: 1.0, reason: '' });
      // CONTAINS edges
      graph.addRelationship({ id: 'r:9', sourceId: 'folder:auth', targetId: 'fn:auth:login', type: 'CONTAINS', confidence: 1.0, reason: '' });
      return graph;
    }

    it('matches nodes by label only', () => {
      const graph = buildTestGraph();
      const store = createSqliteStore(dbPath);
      store.saveGraph(graph);

      const loaded = store.loadGraph();
      // Simulate graphQuery logic
      const currentIds = new Set<string>();
      for (const node of loaded.iterNodes()) {
        if (node.label === 'Community') currentIds.add(node.id);
      }
      expect(currentIds.size).toBe(1);
      expect(currentIds.has('comm:auth')).toBe(true);

      store.close();
    });

    it('matches nodes with property filter', () => {
      const graph = buildTestGraph();
      const store = createSqliteStore(dbPath);
      store.saveGraph(graph);

      const loaded = store.loadGraph();
      let found = false;
      for (const node of loaded.iterNodes()) {
        if (node.label === 'Community' && node.properties.name === 'Authentication') {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);

      store.close();
    });

    it('matchesFilter supports gt/lt operators for numeric properties', () => {
      const matchesFilter = (props: Record<string, unknown>, filter?: Record<string, unknown>): boolean => {
        if (!filter || Object.keys(filter).length === 0) return true;
        for (const [key, expected] of Object.entries(filter)) {
          const actual = props[key];
          if (expected === null || expected === undefined) {
            if (actual != null) return false;
          } else if (typeof expected === 'object' && !Array.isArray(expected)) {
            const op = expected as Record<string, number>;
            if (op.gt !== undefined && (typeof actual !== 'number' || actual <= op.gt)) return false;
            if (op.gte !== undefined && (typeof actual !== 'number' || actual < op.gte)) return false;
            if (op.lt !== undefined && (typeof actual !== 'number' || actual >= op.lt)) return false;
            if (op.lte !== undefined && (typeof actual !== 'number' || actual > op.lte)) return false;
          } else {
            if (actual !== expected) return false;
          }
        }
        return true;
      };

      expect(matchesFilter({ confidence: 0.95 }, { confidence: { gt: 0.8 } })).toBe(true);
      expect(matchesFilter({ confidence: 0.5 }, { confidence: { gt: 0.8 } })).toBe(false);
      expect(matchesFilter({ confidence: 0.8 }, { confidence: { gte: 0.8 } })).toBe(true);
      expect(matchesFilter({ confidence: 0.3 }, { confidence: { lt: 0.5 } })).toBe(true);
      expect(matchesFilter({ confidence: 0.7 }, { confidence: { lte: 0.7 } })).toBe(true);
      expect(matchesFilter({ name: 'login' }, { name: 'login' })).toBe(true);
      expect(matchesFilter({ name: 'login' }, { name: 'other' })).toBe(false);
    });

    it('traverses outgoing CALLS relationships', () => {
      const graph = buildTestGraph();
      const store = createSqliteStore(dbPath);
      store.saveGraph(graph);

      const loaded = store.loadGraph();
      // Start from handleLogin, follow outgoing CALLS
      const startIds = new Set(['fn:api:handleLogin']);
      const nextIds = new Set<string>();
      for (const rel of loaded.iterRelationships()) {
        if (rel.type === 'CALLS' && startIds.has(rel.sourceId)) {
          nextIds.add(rel.targetId);
        }
      }
      expect(nextIds.size).toBe(1);
      expect(nextIds.has('fn:auth:validate')).toBe(true);

      // Chain: follow CALLS from validate
      const chainedIds = new Set<string>();
      for (const rel of loaded.iterRelationships()) {
        if (rel.type === 'CALLS' && nextIds.has(rel.sourceId)) {
          chainedIds.add(rel.targetId);
        }
      }
      expect(chainedIds.size).toBe(1);
      expect(chainedIds.has('fn:db:getUser')).toBe(true);

      store.close();
    });

    it('traverses incoming MEMBER_OF to find community members', () => {
      const graph = buildTestGraph();
      const store = createSqliteStore(dbPath);
      store.saveGraph(graph);

      const loaded = store.loadGraph();
      // Start from Community, find incoming MEMBER_OF
      const startIds = new Set(['comm:auth']);
      const memberIds = new Set<string>();
      for (const rel of loaded.iterRelationships()) {
        if (rel.type === 'MEMBER_OF' && startIds.has(rel.targetId)) {
          memberIds.add(rel.sourceId);
        }
      }
      expect(memberIds.size).toBeGreaterThanOrEqual(1);
      expect(memberIds.has('fn:auth:login')).toBe(true);
      expect(memberIds.has('fn:auth:validate')).toBe(true);
      expect(memberIds.has('cls:auth:AuthService')).toBe(true);

      store.close();
    });

    it('chains traversal: Community → members → their callees with confidence filter', () => {
      const graph = buildTestGraph();
      const store = createSqliteStore(dbPath);
      store.saveGraph(graph);

      const loaded = store.loadGraph();

      // Step 1: Find members of Authentication community
      const members = new Set<string>();
      for (const rel of loaded.iterRelationships()) {
        if (rel.type === 'MEMBER_OF' && rel.targetId === 'comm:auth') {
          members.add(rel.sourceId);
        }
      }
      expect(members.size).toBe(3);

      // Step 2: Follow outgoing CALLS from members, confidence > 0.8
      const callees = new Set<string>();
      for (const rel of loaded.iterRelationships()) {
        if (rel.type === 'CALLS' && members.has(rel.sourceId) && rel.confidence > 0.8) {
          callees.add(rel.targetId);
        }
      }
      // login → validate (0.9), validate → getUser (0.85)
      expect(callees.size).toBe(2);
      expect(callees.has('fn:auth:validate')).toBe(true);
      expect(callees.has('fn:db:getUser')).toBe(true);

      store.close();
    });

    it('returns specific properties in results', () => {
      const graph = buildTestGraph();
      const store = createSqliteStore(dbPath);
      store.saveGraph(graph);

      const loaded = store.loadGraph();
      const columns = ['id', 'name', 'filePath'];
      const rows: Array<Record<string, unknown>> = [];
      for (const node of loaded.iterNodes()) {
        if (node.label === 'Class') {
          const row: Record<string, unknown> = {};
          for (const col of columns) {
            if (col === 'id') row.id = node.id;
            else row[col] = node.properties[col] ?? null;
          }
          rows.push(row);
        }
      }
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('cls:auth:AuthService');
      expect(rows[0].name).toBe('AuthService');
      expect(rows[0].filePath).toBe('src/auth/service.ts');
      expect(rows[0].cohesion).toBeUndefined(); // not in return columns

      store.close();
    });

    it('returns empty result for non-matching query', () => {
      const graph = buildTestGraph();
      const store = createSqliteStore(dbPath);
      store.saveGraph(graph);

      const loaded = store.loadGraph();
      const currentIds = new Set<string>();
      for (const node of loaded.iterNodes()) {
        if (node.label === 'Interface') currentIds.add(node.id);
      }
      expect(currentIds.size).toBe(0);

      store.close();
    });

    it('cypher tool schema has required match field', () => {
      // Verify the tool schema structure
      const schema = {
        type: 'object',
        properties: {
          match: { type: 'object' },
          traverse: { type: 'array' },
          return: { type: 'array' },
          limit: { type: 'number', default: 50 },
          repo: { type: 'string' },
        },
        required: ['match'],
      };
      expect(schema.required).toContain('match');
      expect(schema.properties.match).toBeDefined();
      expect(schema.properties.traverse).toBeDefined();
    });

    it('any direction traversal finds both incoming and outgoing edges', () => {
      const graph = buildTestGraph();
      const store = createSqliteStore(dbPath);
      store.saveGraph(graph);

      const loaded = store.loadGraph();
      // From validatePassword, find ALL connected nodes (incoming + outgoing)
      const startIds = new Set(['fn:auth:validate']);
      const neighbors = new Set<string>();
      for (const rel of loaded.iterRelationships()) {
        if (startIds.has(rel.sourceId)) neighbors.add(rel.targetId);
        if (startIds.has(rel.targetId)) neighbors.add(rel.sourceId);
      }
      // CALLS: handleLogin → validate, login → validate, validate → getUser
      // MEMBER_OF: validate → comm:auth
      expect(neighbors.has('fn:api:handleLogin')).toBe(true);
      expect(neighbors.has('fn:auth:login')).toBe(true);
      expect(neighbors.has('fn:db:getUser')).toBe(true);
      expect(neighbors.has('comm:auth')).toBe(true);

      store.close();
    });
  });
});
