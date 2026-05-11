/**
 * Tests for StreamableHTTP Transport (#710, #738).
 *
 * Tests the transport in isolation using node:http client (no external deps).
 * Uses port 0 for random ports to avoid conflicts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { request, type IncomingMessage } from 'node:http';
import { StreamableHttpTransport } from '../../src/mcp/http-transport.js';

// ── Helpers ──────────────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Make an HTTP request to the transport server.
 */
function makeRequest(opts: {
  method: string;
  path?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(opts.path ?? '/mcp', baseUrl);
    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: opts.method,
      headers: {
        'Content-Type': 'application/json',
        ...opts.headers,
      },
    };

    const req = request(reqOptions, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);

    if (opts.rawBody !== undefined) {
      req.write(opts.rawBody);
    } else if (opts.body !== undefined) {
      req.write(JSON.stringify(opts.body));
    }
    req.end();
  });
}

/**
 * Parse SSE `data:` events from a response body.
 */
function parseSseEvents(body: string): unknown[] {
  const events: unknown[] = [];
  // SSE format: "data: <json>\n\n"
  const segments = body.split('\n\n');
  for (const segment of segments) {
    for (const line of segment.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          events.push(JSON.parse(line.substring(6)));
        } catch {
          // skip malformed
        }
      }
    }
  }
  return events;
}

/**
 * Parse a JSON response body (non-SSE).
 */
function parseJson(body: string): unknown {
  return JSON.parse(body);
}

// ── Test state ───────────────────────────────────────────────────────────

let transport: StreamableHttpTransport;
let baseUrl: string;

// ── Tests ────────────────────────────────────────────────────────────────

describe('StreamableHttpTransport', () => {

  beforeAll(async () => {
    transport = new StreamableHttpTransport({ port: 0, host: '127.0.0.1' });
    await transport.listen();
    baseUrl = transport.address!;
    expect(baseUrl).toBeTruthy();
  });

  afterAll(() => {
    transport.close();
  });

  // ── Basic routing ───────────────────────────────────────────────────

  describe('routing', () => {
    beforeEach(() => {
      // Default message handler: echo back with result
      transport.on('message', async (data: unknown) => {
        const msg = data as { id?: unknown; method?: string };
        transport.send({
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: { method: msg.method, echoed: true },
        });
      });
    });

    it('POST /mcp with valid JSON-RPC request returns SSE response', async () => {
      const res = await makeRequest({
        method: 'POST',
        body: { jsonrpc: '2.0', id: 'test-1', method: 'initialize' },
      });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');

      const events = parseSseEvents(res.body);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        result: { method: 'initialize', echoed: true },
      });
    });

    it('POST /mcp with invalid JSON returns parse error', async () => {
      const res = await makeRequest({
        method: 'POST',
        rawBody: '{invalid json!!!',
      });

      expect(res.status).toBe(200); // SSE headers already sent
      const events = parseSseEvents(res.body);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
    });

    it('POST /mcp with batch request handles each item', async () => {
      const batch = [
        { jsonrpc: '2.0', id: 'b1', method: 'tools/list' },
        { jsonrpc: '2.0', id: 'b2', method: 'resources/list' },
        { jsonrpc: '2.0', id: 'b3', method: 'prompts/list' },
      ];

      const res = await makeRequest({
        method: 'POST',
        body: batch,
      });

      expect(res.status).toBe(200);
      const events = parseSseEvents(res.body);
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ jsonrpc: '2.0', id: 'b1', result: { method: 'tools/list', echoed: true } });
      expect(events[1]).toEqual({ jsonrpc: '2.0', id: 'b2', result: { method: 'resources/list', echoed: true } });
      expect(events[2]).toEqual({ jsonrpc: '2.0', id: 'b3', result: { method: 'prompts/list', echoed: true } });
    });

    it('GET /mcp returns 405', async () => {
      const res = await makeRequest({ method: 'GET' });

      expect(res.status).toBe(405);
      const body = parseJson(res.body) as { error: { message: string } };
      expect(body.error.message).toContain('GET not supported');
    });

    it('DELETE /mcp returns session_terminated', async () => {
      const res = await makeRequest({ method: 'DELETE' });

      expect(res.status).toBe(200);
      const body = parseJson(res.body) as { result: { status: string } };
      expect(body.result.status).toBe('session_terminated');
    });

    it('POST to wrong path returns 404', async () => {
      const res = await makeRequest({
        method: 'POST',
        path: '/other',
        body: { jsonrpc: '2.0', id: 1, method: 'test' },
      });

      expect(res.status).toBe(404);
      const body = parseJson(res.body) as { error: { code: number; message: string } };
      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toContain('Not found');
    });

    it('OPTIONS /mcp returns 204 (CORS preflight)', async () => {
      const res = await makeRequest({ method: 'OPTIONS' });

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toBeDefined();
    });
  });

  // ── Body size limit ─────────────────────────────────────────────────

  it('POST /mcp with body exceeding 10MB returns 413', async () => {
    // Create a body larger than 10MB
    // Use a large string payload to exceed MAX_BODY_SIZE (10 * 1024 * 1024)
    const largePayload = { jsonrpc: '2.0', id: 'big', method: 'test', params: { data: 'x'.repeat(11 * 1024 * 1024) } };

    let res: RawResponse;
    try {
      res = await makeRequest({
        method: 'POST',
        body: largePayload,
      });
    } catch (err) {
      // On some platforms (Windows Node 18), the server closes the connection
      // before the client finishes writing the oversized body, causing
      // ECONNRESET. This is valid — the server did reject the body.
      if (err instanceof Error && /ECONNRESET|EPIPE|socket hang up/i.test(err.message)) {
        return; // test passes — body was rejected
      }
      throw err;
    }

    expect(res.status).toBe(413);
  });

  // ── Concurrency ─────────────────────────────────────────────────────

  describe('concurrency', () => {
    it('two concurrent POST requests get independent responses', async () => {
      // Handler: delay then respond with the request ID
      transport.on('message', async (data: unknown) => {
        const msg = data as { id?: unknown };
        // Small delay to simulate async processing
        await new Promise((r) => setTimeout(r, 10));
        transport.send({
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: { handled: msg.id },
        });
      });

      // Fire two concurrent requests with different IDs
      const [res1, res2] = await Promise.all([
        makeRequest({
          method: 'POST',
          body: { jsonrpc: '2.0', id: 'concurrent-A', method: 'test' },
        }),
        makeRequest({
          method: 'POST',
          body: { jsonrpc: '2.0', id: 'concurrent-B', method: 'test' },
        }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const events1 = parseSseEvents(res1.body);
      const events2 = parseSseEvents(res2.body);

      // Each response must contain its OWN request ID, not the other's
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect((events1[0] as { id: string }).id).toBe('concurrent-A');
      expect((events1[0] as { result: { handled: string } }).result.handled).toBe('concurrent-A');
      expect((events2[0] as { id: string }).id).toBe('concurrent-B');
      expect((events2[0] as { result: { handled: string } }).result.handled).toBe('concurrent-B');
    });
  });

  // ── Async response delivery ─────────────────────────────────────────

  describe('async response delivery', () => {
    it('handler completes before response closes', async () => {
      let handlerCompleted = false;

      transport.on('message', async (data: unknown) => {
        const msg = data as { id?: unknown };
        // Simulate async work
        await new Promise((r) => setTimeout(r, 50));
        transport.send({
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: { async: true },
        });
        handlerCompleted = true;
      });

      const res = await makeRequest({
        method: 'POST',
        body: { jsonrpc: '2.0', id: 'async-test', method: 'test' },
      });

      // Handler must have completed BEFORE the response was sent
      expect(handlerCompleted).toBe(true);
      expect(res.status).toBe(200);

      const events = parseSseEvents(res.body);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ jsonrpc: '2.0', id: 'async-test', result: { async: true } });
    });
  });

  // ── Transport close ─────────────────────────────────────────────────

  describe('transport close', () => {
    it('close prevents new send() calls', () => {
      const t = new StreamableHttpTransport({ port: 0, host: '127.0.0.1' });
      // Don't listen — just test the close/send interaction
      t.close();

      expect(() => t.send({ jsonrpc: '2.0', id: 1, result: {} })).toThrow('Transport is closed');
    });
  });

  // ── CORS headers ────────────────────────────────────────────────────

  describe('CORS', () => {
    it('all responses include CORS headers', async () => {
      transport.on('message', async (data: unknown) => {
        const msg = data as { id?: unknown };
        transport.send({ jsonrpc: '2.0', id: msg.id ?? null, result: {} });
      });

      const res = await makeRequest({
        method: 'POST',
        body: { jsonrpc: '2.0', id: 'cors-test', method: 'test' },
      });

      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toBeDefined();
      expect(res.headers['access-control-allow-headers']).toBeDefined();
    });
  });

  // ── Notifications (no ID) ───────────────────────────────────────────

  describe('notifications', () => {
    it('notification with no ID does not crash the transport', async () => {
      let received: unknown;
      transport.on('message', async (data: unknown) => {
        received = data;
        // Notifications typically don't get a response — handler returns null
      });

      const res = await makeRequest({
        method: 'POST',
        body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });

      expect(res.status).toBe(200);
      expect(received).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
      // No SSE data events for a notification
      const events = parseSseEvents(res.body);
      expect(events).toHaveLength(0);
    });
  });

  // ── Batch with mixed IDs ────────────────────────────────────────────

  describe('batch edge cases', () => {
    it('batch with numeric and string IDs works correctly', async () => {
      transport.on('message', async (data: unknown) => {
        const msg = data as { id?: unknown; method?: string };
        transport.send({
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: { method: msg.method },
        });
      });

      const batch = [
        { jsonrpc: '2.0', id: 42, method: 'test-numeric' },
        { jsonrpc: '2.0', id: 'str-key', method: 'test-string' },
      ];

      const res = await makeRequest({ method: 'POST', body: batch });

      expect(res.status).toBe(200);
      const events = parseSseEvents(res.body);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ jsonrpc: '2.0', id: 42, result: { method: 'test-numeric' } });
      expect(events[1]).toEqual({ jsonrpc: '2.0', id: 'str-key', result: { method: 'test-string' } });
    });
  });
});
