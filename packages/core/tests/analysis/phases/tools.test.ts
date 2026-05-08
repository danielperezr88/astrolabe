/**
 * Tests for the Tools pipeline phase — tool/handler detection (#634).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { toolsPhase } from '../../../src/analysis/phases/tools.js';
import type { ToolsOutput } from '../../../src/analysis/phases/tools.js';
import { createPhaseContext, runPipeline } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';

function makeRepo(fixtures: Record<string, string>): string {
  const tmp = mkdtempSync(join(tmpdir(), 'astrolabe-tools-'));
  for (const [path, content] of Object.entries(fixtures)) {
    const fullPath = join(tmp, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return tmp;
}

function addFileNode(graph: ReturnType<typeof createKnowledgeGraph>, filePath: string): string {
  const nodeId = `file:${filePath}`;
  graph.addNode({
    id: nodeId,
    label: 'File',
    properties: { name: filePath, filePath },
  });
  return nodeId;
}

// ── MCP tool detection (existing) ──────────────────────────────────────────

describe('Tools Phase', () => {
  describe('MCP tool detection', () => {
    it('detects server.tool() calls', async () => {
      const repo = makeRepo({
        'src/tools.ts': `
          server.tool('get_user', 'Get a user', {}, async (args) => { return { name: 'Alice' }; });
          server.tool('create_user', 'Create a user', {}, async (args) => { return { id: 1 }; });
        `,
      });

      const graph = createKnowledgeGraph();
      addFileNode(graph, 'src/tools.ts');
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([toolsPhase], context))[0] as ToolsOutput;

      expect(output.toolCount).toBeGreaterThanOrEqual(2);
      expect(output.toolTypes).toContain('mcp');

      const toolNodes = graph.findNodesByLabel('Tool');
      const mcpTools = toolNodes.filter(n => n.properties.toolType === 'mcp');
      expect(mcpTools.length).toBeGreaterThanOrEqual(2);
      const names = mcpTools.map(n => n.properties.name as string);
      expect(names).toContain('get_user');
      expect(names).toContain('create_user');

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── MCP resource detection (#634) ────────────────────────────────────────

  describe('MCP resource detection', () => {
    it('detects server.resource() calls', async () => {
      const repo = makeRepo({
        'src/resources.ts': `
          server.resource('user_list', 'users://list', async (uri) => { return { text: 'users' }; });
          server.resource('config', 'config://app', async (uri) => { return { text: 'config' }; });
        `,
      });

      const graph = createKnowledgeGraph();
      addFileNode(graph, 'src/resources.ts');
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([toolsPhase], context))[0] as ToolsOutput;

      expect(output.toolCount).toBeGreaterThanOrEqual(2);
      expect(output.toolTypes).toContain('mcp-resource');

      const toolNodes = graph.findNodesByLabel('Tool');
      const resourceNodes = toolNodes.filter(n => n.properties.toolType === 'mcp-resource');
      expect(resourceNodes.length).toBeGreaterThanOrEqual(2);
      const names = resourceNodes.map(n => n.properties.name as string);
      expect(names).toContain('user_list');
      expect(names).toContain('config');

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── GraphQL resolver detection (#634) ────────────────────────────────────

  describe('GraphQL resolver detection', () => {
    it('detects Query and Mutation resolvers', async () => {
      const repo = makeRepo({
        'api/resolvers.ts': `
          const resolvers = {
            Query: {
              getUser: (parent, args, context) => { return context.db.getUser(args.id); },
            },
            Mutation: {
              updateUser: (parent, args, context) => { return context.db.updateUser(args); },
            },
          };
        `,
      });

      const graph = createKnowledgeGraph();
      addFileNode(graph, 'api/resolvers.ts');
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([toolsPhase], context))[0] as ToolsOutput;

      expect(output.toolCount).toBeGreaterThanOrEqual(2);
      expect(output.toolTypes).toContain('graphql-resolver');

      const toolNodes = graph.findNodesByLabel('Tool');
      const gqlNodes = toolNodes.filter(n => n.properties.toolType === 'graphql-resolver');
      expect(gqlNodes.length).toBeGreaterThanOrEqual(2);
      const names = gqlNodes.map(n => n.properties.name as string);
      expect(names).toContain('getUser');
      expect(names).toContain('updateUser');

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── Slack command detection (#634) ───────────────────────────────────────

  describe('Slack command detection', () => {
    it('detects app.command() calls', async () => {
      const repo = makeRepo({
        'src/slack.ts': `
          app.command('/ping', async ({ command, ack, respond }) => { await ack(); await respond('pong'); });
          app.command('/deploy', async ({ command, ack, respond }) => { await ack(); await respond('deploying...'); });
        `,
      });

      const graph = createKnowledgeGraph();
      addFileNode(graph, 'src/slack.ts');
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([toolsPhase], context))[0] as ToolsOutput;

      expect(output.toolCount).toBeGreaterThanOrEqual(2);
      expect(output.toolTypes).toContain('slack-command');

      const toolNodes = graph.findNodesByLabel('Tool');
      const slackNodes = toolNodes.filter(n => n.properties.toolType === 'slack-command');
      expect(slackNodes.length).toBeGreaterThanOrEqual(2);
      const names = slackNodes.map(n => n.properties.name as string);
      expect(names).toContain('/ping');
      expect(names).toContain('/deploy');

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── Fastify plugin detection (#634) ──────────────────────────────────────

  describe('Fastify plugin detection', () => {
    it('detects fastify.decorate() calls', async () => {
      const repo = makeRepo({
        'src/plugins.ts': `
          fastify.decorate('db', new Database());
          fastify.decorate('auth', new AuthService());
        `,
      });

      const graph = createKnowledgeGraph();
      addFileNode(graph, 'src/plugins.ts');
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([toolsPhase], context))[0] as ToolsOutput;

      expect(output.toolCount).toBeGreaterThanOrEqual(2);
      expect(output.toolTypes).toContain('fastify-plugin');

      const toolNodes = graph.findNodesByLabel('Tool');
      const fpNodes = toolNodes.filter(n => n.properties.toolType === 'fastify-plugin');
      expect(fpNodes.length).toBeGreaterThanOrEqual(2);
      const names = fpNodes.map(n => n.properties.name as string);
      expect(names).toContain('db');
      expect(names).toContain('auth');

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── Multiple tool types in same file ────────────────────────────────────

  describe('multiple tool types', () => {
    it('detects different tool types in the same file', async () => {
      const repo = makeRepo({
        'src/mixed.ts': `
          server.tool('query', 'Query tool', {}, async () => {});
          server.resource('data', 'data://list', async () => {});
          app.command('/cmd', async () => {});
        `,
      });

      const graph = createKnowledgeGraph();
      addFileNode(graph, 'src/mixed.ts');
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([toolsPhase], context))[0] as ToolsOutput;

      expect(output.toolCount).toBeGreaterThanOrEqual(3);
      expect(output.toolTypes).toContain('mcp');
      expect(output.toolTypes).toContain('mcp-resource');
      expect(output.toolTypes).toContain('slack-command');

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── No false positives in non-tool files ──────────────────────────────────

  describe('no false positives', () => {
    it('returns zero tool count for non-tool files', async () => {
      const repo = makeRepo({
        'src/utils.ts': `
          export const add = (a: number, b: number): number => a + b;
          export const multiply = (a: number, b: number): number => a * b;
        `,
      });

      const graph = createKnowledgeGraph();
      addFileNode(graph, 'src/utils.ts');
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([toolsPhase], context))[0] as ToolsOutput;

      expect(output.toolCount).toBe(0);
      expect(output.toolTypes).toEqual([]);

      rmSync(repo, { recursive: true, force: true });
    });
  });
});