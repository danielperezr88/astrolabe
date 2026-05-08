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

function addFileNode(
  graph: ReturnType<typeof createKnowledgeGraph>,
  filePath: string,
): string {
  const fileId = `file:${filePath}`;
  graph.addNode({
    id: fileId,
    label: 'File',
    properties: { name: filePath, filePath },
  });
  return fileId;
}

// ── MCP tool detection (existing pattern) ────────────────────────────────

describe('Tools Phase', () => {
  describe('MCP tool detection (existing)', () => {
    it('detects server.tool() calls and creates Tool nodes', async () => {
      const repo = makeRepo({
        'src/tools.ts': `
          server.tool('listFiles', 'List files in a directory', async (input) => { return { content: [] }; });
          server.tool('readFile', 'Read file contents', async (input) => { return { content: [] }; });
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
      expect(names).toContain('listFiles');
      expect(names).toContain('readFile');

      const handlesRels = Array.from(graph.iterRelationshipsByType('HANDLES_TOOL'));
      expect(handlesRels.length).toBeGreaterThanOrEqual(2);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── MCP resource detection ────────────────────────────────────────────

  describe('MCP resource detection', () => {
    it('detects server.resource() calls and creates Tool nodes', async () => {
      const repo = makeRepo({
        'src/resources.ts': `
          server.resource('config', 'config://app', async (uri) => { return { contents: [] }; });
          server.resource('manifest', 'manifest://app', async (uri) => { return { contents: [] }; });
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
      expect(names).toContain('config');
      expect(names).toContain('manifest');

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── GraphQL resolver detection ─────────────────────────────────────────

  describe('GraphQL resolver detection', () => {
    it('detects Query and Mutation resolvers', async () => {
      // Note: the regex captures the first resolver per Query/Mutation block
      // (the engine resumes after the block-header match, so subsequent resolvers
      // in the same block lack the Query/Mutation prefix and are not recaptured).
      const repo = makeRepo({
        'src/resolvers.ts': `
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
      addFileNode(graph, 'src/resolvers.ts');
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

  // ── Slack command detection ────────────────────────────────────────────

  describe('Slack command detection', () => {
    it('detects app.command() calls and creates Tool nodes', async () => {
      const repo = makeRepo({
        'src/slack-app.ts': `
          app.command('/deploy', async ({ command, ack, respond }) => { await ack(); respond('Deploying...'); });
          app.command('/status', async ({ command, ack, respond }) => { await ack(); respond('All systems go'); });
        `,
      });

      const graph = createKnowledgeGraph();
      addFileNode(graph, 'src/slack-app.ts');
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([toolsPhase], context))[0] as ToolsOutput;

      expect(output.toolCount).toBeGreaterThanOrEqual(2);
      expect(output.toolTypes).toContain('slack-command');

      const toolNodes = graph.findNodesByLabel('Tool');
      const slackNodes = toolNodes.filter(n => n.properties.toolType === 'slack-command');
      expect(slackNodes.length).toBeGreaterThanOrEqual(2);

      const names = slackNodes.map(n => n.properties.name as string);
      expect(names).toContain('/deploy');
      expect(names).toContain('/status');

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── Fastify plugin detection ───────────────────────────────────────────

  describe('Fastify plugin detection', () => {
    it('detects fastify.decorate() calls and creates Tool nodes', async () => {
      const repo = makeRepo({
        'plugins/auth.ts': `
          fastify.decorate('authenticate', function(request, reply) { return true; });
          fastify.decorate('verifyRole', function(role) { return function(request, reply) { return true; }; });
        `,
      });

      const graph = createKnowledgeGraph();
      addFileNode(graph, 'plugins/auth.ts');
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([toolsPhase], context))[0] as ToolsOutput;

      expect(output.toolCount).toBeGreaterThanOrEqual(2);
      expect(output.toolTypes).toContain('fastify-plugin');

      const toolNodes = graph.findNodesByLabel('Tool');
      const fastifyNodes = toolNodes.filter(n => n.properties.toolType === 'fastify-plugin');
      expect(fastifyNodes.length).toBeGreaterThanOrEqual(2);

      const names = fastifyNodes.map(n => n.properties.name as string);
      expect(names).toContain('authenticate');
      expect(names).toContain('verifyRole');

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── Multiple tool types in same file ───────────────────────────────────

  describe('multiple tool types in same file', () => {
    it('detects MCP tools and resources in the same file', async () => {
      const repo = makeRepo({
        'src/server.ts': `
          server.tool('search', 'Search the knowledge base', async (input) => { return { content: [] }; });
          server.resource('schema', 'schema://main', async (uri) => { return { contents: [] }; });
        `,
      });

      const graph = createKnowledgeGraph();
      addFileNode(graph, 'src/server.ts');
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([toolsPhase], context))[0] as ToolsOutput;

      expect(output.toolCount).toBeGreaterThanOrEqual(2);
      expect(output.toolTypes).toContain('mcp');
      expect(output.toolTypes).toContain('mcp-resource');

      const toolNodes = graph.findNodesByLabel('Tool');
      expect(toolNodes.length).toBeGreaterThanOrEqual(2);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── No false positives in non-tool files ───────────────────────────────

  describe('no false positives', () => {
    it('returns zero count for files with no tool patterns', async () => {
      const repo = makeRepo({
        'src/utils.ts': 'export const add = (a: number, b: number) => a + b;',
        'src/config.ts': 'export const config = { port: 3000, host: "localhost" };',
      });

      const graph = createKnowledgeGraph();
      addFileNode(graph, 'src/utils.ts');
      addFileNode(graph, 'src/config.ts');
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([toolsPhase], context))[0] as ToolsOutput;

      expect(output.toolCount).toBe(0);
      expect(output.toolTypes).toEqual([]);

      const toolNodes = graph.findNodesByLabel('Tool');
      expect(toolNodes).toHaveLength(0);

      rmSync(repo, { recursive: true, force: true });
    });
  });
});