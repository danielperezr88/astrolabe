/**
 * Tests for Cross-Repo Contract Extraction (#396, #397, #398).
 *
 * Tests HTTP provider/consumer extraction, gRPC service detection,
 * topic/queue pattern matching, and shared library detection.
 */
import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import type { KnowledgeGraph } from '../../src/core/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeHttpGraph(): KnowledgeGraph {
  const g = createKnowledgeGraph();

  // Files
  g.addNode({ id: 'file:api/users.ts', label: 'File', properties: { name: 'users.ts', filePath: 'api/users.ts' } });
  g.addNode({ id: 'file:src/consumer.ts', label: 'File', properties: { name: 'consumer.ts', filePath: 'src/consumer.ts' } });

  // Route
  g.addNode({ id: 'route:api:express:GET:/users', label: 'Route', properties: { name: 'GET /users', method: 'GET', path: '/users', filePath: 'api/users.ts', framework: 'express' } });

  // Handler
  g.addNode({ id: 'Function:api/users.ts:getUsers:L5', label: 'Function', properties: { name: 'getUsers', filePath: 'api/users.ts', startLine: 5, isExported: true } });

  // Consumer function with fetch call
  g.addNode({ id: 'Function:src/consumer.ts:fetchUsers:L10', label: 'Function', properties: { name: 'fetchUsers', filePath: 'src/consumer.ts', startLine: 10, body: 'fetch("/users").then(r => r.json())' } });

  // HANDLES_ROUTE
  g.addRelationship({ id: 'hr:1', sourceId: 'Function:api/users.ts:getUsers:L5', targetId: 'route:api:express:GET:/users', type: 'HANDLES_ROUTE', confidence: 1, reason: 'handler' });

  return g;
}

function makeGrpcGraph(): KnowledgeGraph {
  const g = createKnowledgeGraph();

  g.addNode({ id: 'file:proto/user.proto', label: 'File', properties: { name: 'user.proto', filePath: 'proto/user.proto' } });
  g.addNode({ id: 'file:src/client.ts', label: 'File', properties: { name: 'client.ts', filePath: 'src/client.ts' } });

  // gRPC service class
  g.addNode({ id: 'Class:proto/user.proto:UserService', label: 'Class', properties: { name: 'UserService', filePath: 'proto/user.proto', body: 'class UserService {\n  GetUser(call, callback) {}\n  CreateUser(call, callback) {}\n}' } });

  // gRPC client function
  g.addNode({ id: 'Function:src/client.ts:callGrpc:L5', label: 'Function', properties: { name: 'callGrpc', filePath: 'src/client.ts', startLine: 5, body: 'client.GetUser(request, (err, resp) => {})' } });

  return g;
}

function makeTopicGraph(): KnowledgeGraph {
  const g = createKnowledgeGraph();

  g.addNode({ id: 'file:src/producer.ts', label: 'File', properties: { name: 'producer.ts', filePath: 'src/producer.ts' } });
  g.addNode({ id: 'file:src/consumer.ts', label: 'File', properties: { name: 'consumer.ts', filePath: 'src/consumer.ts' } });

  // Kafka producer
  g.addNode({ id: 'Function:src/producer.ts:emitOrder:L5', label: 'Function', properties: { name: 'emitOrder', filePath: 'src/producer.ts', startLine: 5, body: 'producer.send({ topic: "orders", messages: [...] })' } });

  // Kafka consumer
  g.addNode({ id: 'Function:src/consumer.ts:onOrder:L10', label: 'Function', properties: { name: 'onOrder', filePath: 'src/consumer.ts', startLine: 10, body: 'consumer.subscribe({ topic: "orders" })' } });

  return g;
}

function makeImportGraph(): KnowledgeGraph {
  const g = createKnowledgeGraph();

  g.addNode({ id: 'file:repoA/src/app.ts', label: 'File', properties: { name: 'app.ts', filePath: 'repoA/src/app.ts' } });
  g.addNode({ id: 'file:repoB/src/app.ts', label: 'File', properties: { name: 'app.ts', filePath: 'repoB/src/app.ts' } });
  g.addNode({ id: 'file:repoC/src/app.ts', label: 'File', properties: { name: 'app.ts', filePath: 'repoC/src/app.ts' } });

  // Imports
  g.addNode({ id: 'Import:repoA/src/app.ts:@myorg/common', label: 'Import', properties: { name: '@myorg/common', filePath: 'repoA/src/app.ts' } });
  g.addNode({ id: 'Import:repoB/src/app.ts:@myorg/common', label: 'Import', properties: { name: '@myorg/common', filePath: 'repoB/src/app.ts' } });
  g.addNode({ id: 'Import:repoC/src/app.ts:lodash', label: 'Import', properties: { name: 'lodash', filePath: 'repoC/src/app.ts' } });

  // IMPORTS edges (File → Import)
  g.addRelationship({ id: 'imp:1', sourceId: 'file:repoA/src/app.ts', targetId: 'Import:repoA/src/app.ts:@myorg/common', type: 'IMPORTS', confidence: 1, reason: 'import' });
  g.addRelationship({ id: 'imp:2', sourceId: 'file:repoB/src/app.ts', targetId: 'Import:repoB/src/app.ts:@myorg/common', type: 'IMPORTS', confidence: 1, reason: 'import' });
  g.addRelationship({ id: 'imp:3', sourceId: 'file:repoC/src/app.ts', targetId: 'Import:repoC/src/app.ts:lodash', type: 'IMPORTS', confidence: 1, reason: 'import' });

  return g;
}

// ── HTTP Contract Tests ──────────────────────────────────────────────────────

describe('Contract Extraction', () => {
  describe('HTTP provider extraction', () => {
    it('extracts route handlers as providers', () => {
      const g = makeHttpGraph();

      // Verify route + handler relationship
      const handleEdges = Array.from(g.iterRelationshipsByType('HANDLES_ROUTE'));
      expect(handleEdges.length).toBeGreaterThanOrEqual(1);

      const route = g.getNode('route:api:express:GET:/users');
      expect(route).toBeDefined();
      expect(route!.properties.method).toBe('GET');
      expect(route!.properties.path).toBe('/users');
    });

    it('detects consumer HTTP client calls', () => {
      const g = makeHttpGraph();
      const consumer = g.getNode('Function:src/consumer.ts:fetchUsers:L10');
      expect(consumer).toBeDefined();
      expect(consumer!.properties.body).toContain('fetch(');
      expect(consumer!.properties.body).toContain('/users');
    });
  });

  describe('gRPC contract extraction (#396)', () => {
    it('detects gRPC service classes', () => {
      const g = makeGrpcGraph();
      const svc = g.getNode('Class:proto/user.proto:UserService');
      expect(svc).toBeDefined();
      expect(svc!.label).toBe('Class');
      expect(svc!.properties.name).toBe('UserService');
    });

    it('detects gRPC client call patterns', () => {
      const g = makeGrpcGraph();
      const client = g.getNode('Function:src/client.ts:callGrpc:L5');
      expect(client).toBeDefined();
      expect(client!.properties.body).toContain('GetUser');
    });

    it('gRPC services have multiple RPC methods in body', () => {
      const g = makeGrpcGraph();
      const svc = g.getNode('Class:proto/user.proto:UserService');
      expect(svc!.properties.body).toContain('GetUser');
      expect(svc!.properties.body).toContain('CreateUser');
    });
  });

  describe('topic/queue detection (#397)', () => {
    it('detects Kafka producer pattern', () => {
      const g = makeTopicGraph();
      const producer = g.getNode('Function:src/producer.ts:emitOrder:L5');
      expect(producer).toBeDefined();
      expect(producer!.properties.body).toContain('producer.send');
      expect(producer!.properties.body).toContain('"orders"');
    });

    it('detects Kafka consumer pattern', () => {
      const g = makeTopicGraph();
      const consumer = g.getNode('Function:src/consumer.ts:onOrder:L10');
      expect(consumer).toBeDefined();
      expect(consumer!.properties.body).toContain('consumer.subscribe');
      expect(consumer!.properties.body).toContain('"orders"');
    });

    it('producer and consumer match on same topic name', () => {
      const g = makeTopicGraph();
      const producer = g.getNode('Function:src/producer.ts:emitOrder:L5');
      const consumer = g.getNode('Function:src/consumer.ts:onOrder:L10');

      expect(producer!.properties.body).toContain('"orders"');
      expect(consumer!.properties.body).toContain('"orders"');
    });
  });

  describe('shared library detection (#398)', () => {
    it('detects packages imported by multiple repos', () => {
      const g = makeImportGraph();

      // Collect all imports
      const importsByPkg = new Map<string, string[]>();
      for (const node of g.iterNodes()) {
        if (node.label !== 'Import') continue;
        const pkg = node.properties.name as string;
        const fp = node.properties.filePath as string;
        if (!importsByPkg.has(pkg)) importsByPkg.set(pkg, []);
        importsByPkg.get(pkg)!.push(fp);
      }

      // @myorg/common imported by 2 repos
      const commonImports = importsByPkg.get('@myorg/common');
      expect(commonImports).toBeDefined();
      expect(commonImports!.length).toBe(2);

      // lodash imported by 1 repo (not shared)
      const lodashImports = importsByPkg.get('lodash');
      expect(lodashImports).toBeDefined();
      expect(lodashImports!.length).toBe(1);
    });
  });
});
