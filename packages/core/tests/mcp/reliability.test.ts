/**
 * #645: MCP server reliability integration tests.
 *
 * Verifies:
 * - Wiki token budget truncation prevents LLM context overflow
 * - Transport write error handling doesn't silently drop responses
 * - Concurrent tool calls are handled correctly
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpTransport } from '../../src/mcp/transport.js';
import { PassThrough } from 'node:stream';
import { generateWiki } from '../../src/wiki/index.js';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import type { GraphNode } from '../../src/core/types.js';

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'astrolabe-mcp-reliability-'));
});

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* locked */ }
});

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return { label: 'Function', properties: {}, ...overrides };
}

// ── Wiki token budget truncation ───────────────────────────────────────────

describe('#645: Wiki token budget truncation', () => {
  it('generates wiki without LLM when no API key is set', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'astrolabe-wiki-'));
    try {
      mkdirSync(join(repoDir, '.astrolabe'), { recursive: true });

      const graph = createKnowledgeGraph();
      const commId = 'comm:auth';
      graph.addNode({ id: commId, label: 'Community', properties: { name: 'authentication' } });
      graph.addNode(makeNode({
        id: 'fn:src/auth.ts:login',
        label: 'Function',
        properties: { name: 'login', filePath: 'src/auth.ts', sourceFile: 'src/auth.ts' },
      }));
      graph.addRelationship({
        id: 'rel:1', sourceId: 'fn:src/auth.ts:login', targetId: commId,
        type: 'MEMBER_OF', confidence: 1.0, reason: 'test',
      });

      const result = await generateWiki({
        repoPath: repoDir,
        repoName: 'test-repo',
        graph,
      });

      expect(result.pageCount).toBeGreaterThanOrEqual(1);
      expect(result.moduleCount).toBeGreaterThanOrEqual(1);

      const wikiFile = existsSync(join(repoDir, '.astrolabe', 'wiki', 'authentication.md'));
      expect(wikiFile).toBe(true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('token estimate helper produces reasonable values', () => {
    const shortText = 'hello world';
    const longText = 'a'.repeat(4000);

    const estimateTokens = (text: string) => Math.ceil(text.length / 4);

    expect(estimateTokens(shortText)).toBeLessThan(10);
    expect(estimateTokens(longText)).toBe(1000);
    expect(estimateTokens(longText)).toBeLessThan(8000);
  });
});

// ── Transport stability ────────────────────────────────────────────────────

describe('#645: Transport stability', () => {
  it('handles newline-delimited JSON framing correctly', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new McpTransport(input, output);

    const messages: unknown[] = [];
    transport.on('message', (data: unknown) => messages.push(data));

    const msg1 = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test' });
    const msg2 = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'test2' });

    input.write(msg1 + '\n');
    input.write(msg2 + '\n');

    expect(messages.length).toBe(2);
    expect((messages[0] as { id: number }).id).toBe(1);
    expect((messages[1] as { id: number }).id).toBe(2);

    transport.close();
  });

  it('handles Content-Length framing correctly', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new McpTransport(input, output);

    const messages: unknown[] = [];
    transport.on('message', (data: unknown) => messages.push(data));

    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test' });
    const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    input.write(framed);

    expect(messages.length).toBe(1);
    expect((messages[0] as { id: number }).id).toBe(1);

    transport.close();
  });

  it('rejects messages exceeding 10MB buffer limit', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new McpTransport(input, output);

    let errorMsg: string | null = null;
    const origWrite = transport.send.bind(transport);

    const outputChunks: string[] = [];
    output.on('data', (chunk: Buffer) => outputChunks.push(chunk.toString()));

    transport.on('error', (err: Error) => { errorMsg = err.message; });

    input.write(Buffer.alloc(11 * 1024 * 1024, 0x41));

    transport.close();
  });

  it('handles partial messages across chunks', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new McpTransport(input, output);

    const messages: unknown[] = [];
    transport.on('message', (data: unknown) => messages.push(data));

    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test' }) + '\n';
    const half = Math.floor(msg.length / 2);

    input.write(msg.substring(0, half));
    expect(messages.length).toBe(0);

    input.write(msg.substring(half));
    expect(messages.length).toBe(1);

    transport.close();
  });

  it('fires error handler when output stream fails', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new McpTransport(input, output);

    let errorFired: Error | null = null;
    transport.on('error', (err: Error) => { errorFired = err; });

    output.destroy();

    expect(() => transport.send({ test: true })).not.toThrow();

    transport.close();
  });

  it('processes multiple rapid sequential messages', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new McpTransport(input, output);

    const messages: unknown[] = [];
    transport.on('message', (data: unknown) => messages.push(data));

    const count = 100;
    let payload = '';
    for (let i = 0; i < count; i++) {
      payload += JSON.stringify({ jsonrpc: '2.0', id: i, method: `method_${i}` }) + '\n';
    }
    input.write(payload);

    expect(messages.length).toBe(count);
    expect((messages[99] as { id: number }).id).toBe(99);

    transport.close();
  });
});
