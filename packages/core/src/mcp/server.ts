/**
 * MCP Server for Astrolabe.
 *
 * Implements the Model Context Protocol (JSON-RPC over stdio) so that
 * AI assistants can query the knowledge graph. Provides tools for
 * symbol search, relationship traversal, and code impact analysis.
 *
 * Usage: npx @astrolabe/cli serve-mcp [--db path/to/astrolabe.db]
 */

import { createInterface } from 'node:readline';

// ── Types ──────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

// ── MCP Protocol ────────────────────────────────────────────────────────────

const TOOLS: Record<string, {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}> = {
  'astrolabe.search': {
    name: 'astrolabe.search',
    description: 'Search the codebase knowledge graph for symbols matching a query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (symbol name, file path, etc.)' },
        limit: { type: 'number', description: 'Max results (default 20)', default: 20 },
      },
      required: ['query'],
    },
    handler: async (params) => {
      const { query, limit = 20 } = params;
      return {
        content: [
          { type: 'text', text: `Search for "${query}" (limit: ${limit}) — connect to database for results` },
        ],
      };
    },
  },
  'astrolabe.relationships': {
    name: 'astrolabe.relationships',
    description: 'Get relationships for a given symbol (callers, imports, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        symbolId: { type: 'string', description: 'Node ID of the symbol' },
        direction: { type: 'string', enum: ['in', 'out', 'both'], default: 'both' },
      },
      required: ['symbolId'],
    },
    handler: async (params) => {
      const { symbolId, direction = 'both' } = params;
      return {
        content: [
          { type: 'text', text: `Relationships for "${symbolId}" (direction: ${direction}) — connect to database` },
        ],
      };
    },
  },
  'astrolabe.analyze': {
    name: 'astrolabe.analyze', 
    description: 'Analyze a codebase and build the knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        repoPath: { type: 'string', description: 'Path to repository to analyze' },
        force: { type: 'boolean', description: 'Force re-analysis', default: false },
      },
      required: ['repoPath'],
    },
    handler: async (params) => {
      const { repoPath, force = false } = params;
      return {
        content: [
          { type: 'text', text: `Analyze "${repoPath}" (force: ${force}) — requires @astrolabe/core` },
        ],
      };
    },
  },
};

// ── Server implementation ───────────────────────────────────────────────────

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'astrolabe', version: '0.1.0' },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: Object.values(TOOLS).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case 'tools/call': {
      const params = req.params as { name: string; arguments?: unknown } | undefined;
      const tool = TOOLS[params?.name ?? ''];
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `Unknown tool: ${params?.name}` },
        };
      }
      try {
        const result = await tool.handler((params?.arguments as Record<string, unknown>) ?? {});
        return { jsonrpc: '2.0', id: req.id, result };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32603, message: (err as Error).message },
        };
      }
    }

    case 'notifications/initialized':
      // Do NOT respond to notifications per MCP spec
      return undefined as any;

    default:
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

export async function startMcpServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  for await (const line of rl) {
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      const res = await handleRequest(req);
      process.stdout.write(JSON.stringify(res) + '\n');
    } catch {
      process.stderr.write('{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"}}\n');
    }
  }
}
