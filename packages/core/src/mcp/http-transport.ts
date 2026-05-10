/**
 * MCP StreamableHTTP Transport (#710).
 *
 * Implements the MCP StreamableHTTP protocol:
 * - POST /mcp with JSON-RPC body → SSE response stream
 * - Each JSON-RPC response is sent as an SSE `data:` event
 * - GET /mcp returns 405 (not supported in initial implementation)
 * - DELETE /mcp terminates the session
 *
 * Uses the same `on`/`send`/`close` interface as McpTransport so the
 * MCP server dispatch layer works identically over both transports.
 *
 * No external dependencies — uses Node.js built-in `http` module.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

// ── Types ──────────────────────────────────────────────────────────────────

export interface StreamableHttpTransportOptions {
  /** Port to listen on. Default: 4748. */
  port?: number;
  /** Host to bind to. Default: 'localhost'. */
  host?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PORT = 4748;
const DEFAULT_HOST = 'localhost';
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB — matches stdio transport

// ── StreamableHTTP Transport ───────────────────────────────────────────────

/**
 * MCP StreamableHTTP transport.
 *
 * Client POSTs JSON-RPC requests to /mcp. The server responds with an SSE
 * stream containing one `data:` event per JSON-RPC response. Each request
 * opens a new SSE stream that closes after the response is sent.
 */
export class StreamableHttpTransport {
  private server: Server;
  private closed = false;
  private port: number;
  private host: string;

  // Callbacks — same pattern as McpTransport
  private onMessage: ((data: unknown) => void) = () => {};
  private onError: ((err: Error) => void) = () => {};

  constructor(options?: StreamableHttpTransportOptions) {
    this.port = options?.port ?? DEFAULT_PORT;
    this.host = options?.host ?? DEFAULT_HOST;
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  /**
   * Start listening. Returns a promise that resolves when the server is ready.
   */
  async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * The address the server is listening on, or null if not started.
   */
  get address(): string | null {
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return addr;
    return `http://${addr.address}:${addr.port}`;
  }

  // ── HTTP Request Handling ───────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      this.setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // CORS headers on all responses
    this.setCorsHeaders(res);

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Only /mcp endpoint is supported
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Not found. Use POST /mcp.' } }));
      return;
    }

    // Route by method
    switch (req.method) {
      case 'POST':
        return this.handlePost(req, res);
      case 'GET':
        return this.handleGet(req, res);
      case 'DELETE':
        return this.handleDelete(req, res);
      default:
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: `Method ${req.method} not allowed. Use POST.` } }));
    }
  }

  /**
   * POST /mcp — receive JSON-RPC request, respond with SSE stream.
   *
   * The request body is parsed as JSON. For each JSON-RPC message, the
   * transport emits a 'message' event. The server dispatch layer calls
   * `send()` which writes the response as an SSE `data:` event.
   */
  private async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (body === null) {
      // readBody already sent error response
      return;
    }

    // Set up SSE response headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Wire send() to write to this response's SSE stream
    this._activeResponse = res;

    try {
      // Parse — may be a single request or batch
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        this.writeSse(res, JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: invalid JSON' },
        }));
        res.end();
        return;
      }

      // Handle batch (array of requests)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          this.onMessage(item);
        }
      } else {
        this.onMessage(parsed);
      }
    } catch (err) {
      this.writeSse(res, JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Internal error' },
      }));
    } finally {
      // End SSE stream after a tick to allow any pending send() calls to flush
      this._activeResponse = null;
      setImmediate(() => {
        if (!res.writableEnded) res.end();
      });
    }
  }

  /**
   * GET /mcp — not supported in this implementation.
   * Returns 405 with a helpful message.
   */
  private handleGet(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'GET not supported. Use POST /mcp for JSON-RPC requests.' } }));
  }

  /**
   * DELETE /mcp — terminate the session.
   */
  private handleDelete(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, result: { status: 'session_terminated' } }));
  }

  // ── Active response for send() targeting ────────────────────────────────

  private _activeResponse: ServerResponse | null = null;

  /**
   * Send a JSON-RPC response. Writes it as an SSE `data:` event to the
   * active POST response stream.
   */
  send(data: unknown): void {
    if (this.closed) {
      throw new Error('Transport is closed');
    }

    const res = this._activeResponse;
    if (res && !res.writableEnded) {
      this.writeSse(res, JSON.stringify(data));
    }
  }

  /**
   * Write an SSE `data:` event to the response stream.
   */
  private writeSse(res: ServerResponse, data: string): void {
    try {
      res.write(`data: ${data}\n\n`);
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      this.closed = true;
    }
  }

  /**
   * Close the transport and shut down the HTTP server.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.close();
  }

  // ── Event Handlers ──────────────────────────────────────────────────────

  /**
   * Set the message handler. Same interface as McpTransport.
   */
  on(event: 'message', handler: (data: unknown) => void): void;
  /**
   * Set the error handler. Same interface as McpTransport.
   */
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'message' | 'error', handler: ((data: unknown) => void) | ((err: Error) => void)): void {
    if (event === 'message') {
      this.onMessage = handler as (data: unknown) => void;
    } else if (event === 'error') {
      this.onError = handler as (err: Error) => void;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Read the full request body with size limit.
   * Returns null if an error response was already sent.
   */
  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;

      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          // Already sent a response — caller should not write
          const res = this._activeResponse;
          if (res && !res.headersSent) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Request body exceeds 10 MB limit' } }));
          }
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });

      req.on('error', (err) => {
        this.onError(err);
        resolve(null);
      });
    });
  }

  /**
   * Set standard CORS headers for browser-based MCP clients.
   */
  private setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
}
