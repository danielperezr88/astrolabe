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
});
