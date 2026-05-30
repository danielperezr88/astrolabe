/**
 * MCP Server for Astrolabe.
 *
 * Full Model Context Protocol server (JSON-RPC over stdio) with 29 working
 * tools backed by the SQLite knowledge graph database and a global registry
 * for multi-repo support.
 *
 * Refactored (#838): Business logic extracted into focused sub-modules:
 *   - backend.ts   — LocalBackend class, types, helper functions
 *   - tools.ts     — All 29 tool definitions
 *   - resources.ts — Resource handlers
 *   - prompts.ts   — Prompt handlers
 */

import { LocalBackend, type JsonRpcRequest, type JsonRpcResponse } from './backend.js';
import { createTools, type ToolDefinition } from './tools.js';
import { createResourceHandlers, type ResourceHandlers } from './resources.js';
import { getPrompts, getPromptMessages } from './prompts.js';
import { McpTransport } from './transport.js';
import { StreamableHttpTransport } from './http-transport.js';

// ── Singleton backend & wired handlers ─────────────────────────────────────

const backend = new LocalBackend();
const TOOLS: Record<string, ToolDefinition> = createTools(backend);
const resourceHandlers: ResourceHandlers = createResourceHandlers(backend);

// ── Server ─────────────────────────────────────────────────────────────────

function isNotification(method: string): boolean {
  return method.startsWith('notifications/');
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: { subscribe: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'astrolabe', version: '0.2.0' },
        },
      };

    case 'resources/list':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: { resources: [...resourceHandlers.getResources(), ...resourceHandlers.getResourceTemplates()] },
      };

    case 'resources/templates/list':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: { resourceTemplates: resourceHandlers.getResourceTemplates() },
      };

    case 'resources/read': {
      const rParams = req.params as { uri: string } | undefined;
      const content = resourceHandlers.readResource(rParams?.uri ?? '');
      if (!content) {
        return { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `Resource not found: ${rParams?.uri}` } };
      }
      return { jsonrpc: '2.0', id: req.id, result: { contents: [{ uri: rParams!.uri, mimeType: 'text/plain', text: content }] } };
    }

    case 'prompts/list':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: { prompts: getPrompts() },
      };

    case 'prompts/get': {
      const pParams = req.params as { name: string; arguments?: Record<string, string> } | undefined;
      const messages = getPromptMessages(pParams?.name ?? '', pParams?.arguments ?? {});
      if (!messages) {
        return { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `Prompt not found: ${pParams?.name}` } };
      }
      return { jsonrpc: '2.0', id: req.id, result: { messages } };
    }

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
          error: { code: -32601, message: `Unknown tool: ${params?.name}. Available: ${Object.keys(TOOLS).join(', ')}` },
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
    case 'notifications/cancelled':
    case 'notifications/progress':
      return null;

    default:
      if (isNotification(req.method)) return null;
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

export interface McpServerOptions {
  /** Transport type: 'stdio' (default) or 'http' (StreamableHTTP). */
  transport?: 'stdio' | 'http';
  /** Port for HTTP transport. Default: 4748. Only used when transport is 'http'. */
  port?: number;
  /** Host for HTTP transport. Default: 'localhost'. Only used when transport is 'http'. */
  host?: string;
}

export async function startMcpServer(options?: McpServerOptions): Promise<void> {
  const transportType = options?.transport ?? 'stdio';

  // ── HTTP (StreamableHTTP) transport ────────────────────────────────────
  if (transportType === 'http') {
    const httpTransport = new StreamableHttpTransport({
      port: options?.port,
      host: options?.host,
    });

    await httpTransport.listen();
    const addr = httpTransport.address ?? `http://localhost:${options?.port ?? 4748}`;
    console.error(`Astrolabe MCP server (StreamableHTTP) listening on ${addr}/mcp`);

    // Graceful shutdown
    process.on('SIGINT', () => { backend.shutdown(); httpTransport.close(); process.exit(0); });
    process.on('SIGTERM', () => { backend.shutdown(); httpTransport.close(); process.exit(0); });

    httpTransport.on('message', async (data: unknown) => {
      try {
        const req = data as JsonRpcRequest;
        const res = await handleRequest(req);
        if (res !== null) {
          httpTransport.send(res);
        }
      } catch {
        // Parse error already handled by transport
      }
    });

    httpTransport.on('error', (err: Error) => {
      console.error('MCP HTTP transport error:', err.message);
    });
    return;
  }

  // ── Stdio transport (default) ──────────────────────────────────────────
  // #274: Dual-framing transport with security hardening
  const transport = new McpTransport(process.stdin, process.stdout);

  // Graceful shutdown
  process.on('SIGINT', () => { backend.shutdown(); transport.close(); process.exit(0); });
  process.on('SIGTERM', () => { backend.shutdown(); transport.close(); process.exit(0); });

  transport.on('message', async (data: unknown) => {
    try {
      const req = data as JsonRpcRequest;
      const res = await handleRequest(req);
      if (res !== null) {
        transport.send(res);
      }
    } catch {
      // Parse error already handled by transport
    }
  });
}
