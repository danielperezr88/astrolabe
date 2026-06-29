/**
 * Integration tests for the MCP server — end-to-end via JSON-RPC over stdio (#536).
 *
 * Spawns the MCP server as a subprocess, sends JSON-RPC requests via stdin
 * (newline-delimited JSON framing), and reads responses from stdout.
 *
 * Tests the full tool dispatch pipeline: transport → JSON-RPC parse →
 * tool handler → backend → result formatting.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteStore } from '../../src/persist/sqlite.js';
import { createFtsSearch } from '../../src/search/fts.js';
import { createKnowledgeGraph } from '../../src/core/graph.js';

// ── Helpers ──────────────────────────────────────────────────────────────

let testDir: string;
let dbPath: string;
let child: ChildProcess;
let msgId = 0;
let responseBuffer = '';
let stderrBuffer = '';
let pendingResolvers = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

/** Handle incoming data — parse newline-delimited JSON and dispatch to waiting callers. */
function handleStdoutData(data: Buffer) {
  responseBuffer += data.toString();
  const lines = responseBuffer.split('\n');
  responseBuffer = lines.pop() ?? ''; // Keep incomplete line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pendingResolvers.has(msg.id)) {
        const { resolve, timer } = pendingResolvers.get(msg.id)!;
        clearTimeout(timer);
        pendingResolvers.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // Incomplete JSON — ignore
    }
  }
}

/** Send a JSON-RPC request and return the response promise. */
function sendRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const req = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n';

    const timer = setTimeout(() => {
      pendingResolvers.delete(id);
      reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
    }, 15000);

    pendingResolvers.set(id, { resolve, reject, timer });
    child.stdin!.write(req);
  });
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Use isolated temp directory for DB, registry, and subprocess home
  testDir = mkdtempSync(resolve(tmpdir(), 'astrolabe-mcp-e2e-'));
  dbPath = resolve(testDir, 'mcp-e2e.db');

  const store = createSqliteStore(dbPath);
  const graph = createKnowledgeGraph();
  graph.addNode({ id: 'fn:app:authenticate', label: 'Function', properties: { name: 'authenticate', filePath: 'src/auth.ts' } });
  graph.addNode({ id: 'fn:app:login', label: 'Function', properties: { name: 'login', filePath: 'src/login.ts' } });
  graph.addNode({ id: 'fn:app:hashPassword', label: 'Function', properties: { name: 'hashPassword', filePath: 'src/auth.ts' } });
  graph.addNode({ id: 'fn:app:validateToken', label: 'Function', properties: { name: 'validateToken', filePath: 'src/auth.ts' } });
  graph.addRelationship({
    id: 'rel:call1', sourceId: 'fn:app:login', targetId: 'fn:app:authenticate',
    type: 'CALLS', confidence: 0.95, reason: 'login calls authenticate',
  });
  graph.addRelationship({
    id: 'rel:call2', sourceId: 'fn:app:hashPassword', targetId: 'fn:app:authenticate',
    type: 'CALLS', confidence: 0.90, reason: 'hashing related to auth',
  });
  graph.addRelationship({
    id: 'rel:call3', sourceId: 'fn:app:login', targetId: 'fn:app:validateToken',
    type: 'CALLS', confidence: 0.85, reason: 'login validates token',
  });
  store.saveGraph(graph);

  const fts = createFtsSearch(dbPath);
  fts.indexGraph(store);
  fts.close();
  store.close();

  // Register in subprocess-isolated registry (separate home dir)
  const astrolabeDir = resolve(testDir, '.astrolabe');
  mkdirSync(astrolabeDir);
  writeFileSync(resolve(astrolabeDir, 'registry.json'), JSON.stringify([{
    name: 'mcp-e2e-repo',
    path: testDir,
    dbPath,
    lastCommit: 'abc123',
    indexedAt: Date.now(),
  }]));

  // Spawn MCP server via helper (which calls startMcpServer())
  const helperPath = resolve(__dirname, 'mcp-server-helper.mjs');
  child = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Isolate subprocess home dir so registry.json is from testDir
      HOME: testDir,
      USERPROFILE: testDir,
    },
  });

  // Wait for READY signal on stderr before sending requests
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    child.stderr!.on('data', (d: Buffer) => {
      stderrBuffer += d.toString();
      if (stderrBuffer.includes('READY\n')) resolveReady();
    });
    setTimeout(() => rejectReady(new Error(`MCP server not ready after 25s. stderr: ${stderrBuffer}`)), 25000);
  });

  child.stdout!.on('data', handleStdoutData);

  await ready;

  // Send initialize request to start the server
  const initResponse = await sendRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  const init = initResponse as { result?: { capabilities?: unknown } };
  expect(init.result?.capabilities).toBeDefined();

  // Send initialized notification
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  // Small delay for the notification to be processed
  await new Promise((r) => setTimeout(r, 100));
}, 30000);

afterAll(() => {
  child?.kill();
  // Log stderr for debugging (helps diagnose subprocess startup failures)
  if (stderrBuffer) console.warn(`[MCP server stderr]:\n${stderrBuffer}`);
  // Temp dir may be locked by subprocess SQLite — best-effort cleanup
  try { if (testDir) rmSync(testDir, { recursive: true, force: true }); } catch { /* locked */ }
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('MCP Server E2E (#536)', () => {
  // ── Protocol ──────────────────────────────────────────────────────────

  describe('protocol', () => {
    it('responds to tools/list with available tools', async () => {
      const msg = await sendRpc('tools/list') as { result?: { tools?: Array<{ name: string }> } };
      expect(msg.result?.tools).toBeDefined();
      const tools = msg.result!.tools!;
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('astrolabe.list_repos');
      expect(toolNames).toContain('astrolabe.query');
      expect(toolNames).toContain('astrolabe.context');
      expect(toolNames).toContain('astrolabe.impact');
      expect(toolNames.length).toBeGreaterThanOrEqual(10);
    });

    it('returns error for unknown method', async () => {
      const msg = await sendRpc('nonexistent/method') as { error?: { code: number; message: string } };
      expect(msg.error).toBeDefined();
      expect(msg.error!.code).toBe(-32601);
    });
  });

  // ── Tools ─────────────────────────────────────────────────────────────

  describe('tools', () => {
    it('list_repos returns indexed repos', async () => {
      const msg = await sendRpc('tools/call', {
        name: 'astrolabe.list_repos',
        arguments: {},
      }) as { result?: { content?: Array<{ type: string; text: string }> } };
      expect(msg.result?.content).toBeDefined();
      const text = msg.result!.content![0].text;
      expect(text).toContain('mcp-e2e-repo');
    });

    it('query returns search results', async () => {
      const msg = await sendRpc('tools/call', {
        name: 'astrolabe.query',
        arguments: { query: 'authenticate' },
      }) as { result?: { content?: Array<{ type: string; text: string }> } };
      expect(msg.result?.content).toBeDefined();
      const text = msg.result!.content![0].text;
      expect(text).toContain('authenticate');
    });

    it('query requires query parameter', async () => {
      const msg = await sendRpc('tools/call', {
        name: 'astrolabe.query',
        arguments: {},
      }) as { error?: { code: number; message: string } };
      expect(msg.error).toBeDefined();
      expect(msg.error!.message).toContain('query');
    });

    it('context returns symbol context', async () => {
      const msg = await sendRpc('tools/call', {
        name: 'astrolabe.context',
        arguments: { name: 'authenticate' },
      }) as { result?: { content?: Array<{ type: string; text: string }> } };
      expect(msg.result?.content).toBeDefined();
      const text = msg.result!.content![0].text;
      expect(text).toContain('authenticate');
    });

    it('context requires name parameter', async () => {
      const msg = await sendRpc('tools/call', {
        name: 'astrolabe.context',
        arguments: {},
      }) as { error?: { code: number; message: string } };
      expect(msg.error).toBeDefined();
      expect(msg.error!.message).toContain('name');
    });

    it('impact returns blast radius', async () => {
      const msg = await sendRpc('tools/call', {
        name: 'astrolabe.impact',
        arguments: { target: 'authenticate' },
      }) as { result?: { content?: Array<{ type: string; text: string }> } };
      expect(msg.result?.content).toBeDefined();
      const text = msg.result!.content![0].text;
      expect(text).toContain('login');
    });

    it('unknown tool returns error', async () => {
      const msg = await sendRpc('tools/call', {
        name: 'astrolabe.nonexistent',
        arguments: {},
      }) as { error?: { code: number; message: string } };
      expect(msg.error).toBeDefined();
      expect(msg.error!.code).toBe(-32601);
      expect(msg.error!.message).toContain('Unknown tool');
    });
  });
});
