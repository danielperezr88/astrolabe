/**
 * MCP Transport — dual-framing stdio transport with security hardening (#274).
 *
 * Auto-detects framing on first message:
 * - Content-Length header (standard MCP, used by Codex/OpenCode)
 * - Newline-delimited JSON (used by Cursor/Claude Code)
 *
 * Security:
 * - MAX_BUFFER_SIZE = 10 MB cap to prevent OOM
 * - Content-Length validation before allocation
 * - Iterative (not recursive) message reading
 */

import { Writable } from 'node:stream';

// ── Constants ──────────────────────────────────────────────────────────────

/** Maximum message size in bytes to prevent OOM attacks. */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB

// ── Types ──────────────────────────────────────────────────────────────────

export type Framing = 'content-length' | 'newline' | 'unknown';

export interface TransportMessage {
  /** The parsed JSON message. */
  data: unknown;
  /** The framing format used (determined by first message). */
  framing: Framing;
}

// ── Dual-framing transport ─────────────────────────────────────────────────

/**
 * MCP stdio transport that auto-detects framing and enforces security limits.
 *
 * Reads from stdin, writes responses to stdout. Framing is determined by
 * the first received message and used for all subsequent responses.
 */
export class McpTransport {
  private framing: Framing = 'unknown';
  private output: Writable;
  private closed = false;

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    this.output = output as Writable;
    this.setupInput(input);
  }

  private setupInput(input: NodeJS.ReadableStream): void {
    let chunks: Buffer[] = [];
    let totalSize = 0;

    input.on('data', (chunk: Buffer) => {
      if (this.closed) return;

      totalSize += chunk.length;
      if (totalSize > MAX_BUFFER_SIZE) {
        this.writeError('Message exceeds maximum buffer size (10 MB)');
        chunks = [];
        totalSize = 0;
        return;
      }

      chunks.push(chunk);

      // Try to extract complete messages iteratively
      const data = Buffer.concat(chunks);
      let offset = 0;

      while (offset < data.length) {
        if (this.framing === 'unknown') {
          // Detect framing from first bytes
          const header = data.subarray(offset, Math.min(offset + 20, data.length)).toString();
          if (header.startsWith('Content-Length:')) {
            this.framing = 'content-length';
          } else {
            this.framing = 'newline';
          }
        }

        if (this.framing === 'content-length') {
          const result = this.tryParseContentLength(data, offset);
          if (result === null) break; // need more data
          offset = result.nextOffset;
          this.emit(result.message);
        } else {
          const result = this.tryParseNewline(data, offset);
          if (result === null) break; // need more data
          offset = result.nextOffset;
          if (result.message) this.emit(result.message); // #414: skip empty (sentinel)
        }
      }

      // Keep remaining data for next chunk
      chunks = offset < data.length ? [data.subarray(offset)] : [];
      totalSize = data.length - offset;
    });

    input.on('end', () => {
      this.closed = true;
    });

    input.on('error', () => {
      this.closed = true;
    });
  }

  /**
   * Try to parse a Content-Length framed message.
   * Returns null if more data is needed.
   */
  private tryParseContentLength(
    data: Buffer,
    offset: number,
  ): { message: string; nextOffset: number } | null {
    const str = data.subarray(offset).toString();
    const headerMatch = str.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/);
    if (!headerMatch) return null;

    const contentLength = parseInt(headerMatch[1], 10);

    // Security: validate Content-Length before allocation
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      this.writeError('Invalid Content-Length header');
      return { message: '', nextOffset: data.length };
    }

    if (contentLength > MAX_BUFFER_SIZE) {
      this.writeError(`Content-Length ${contentLength} exceeds maximum (10 MB)`);
      return { message: '', nextOffset: data.length };
    }

    const headerEnd = headerMatch.index! + headerMatch[0].length;
    const bodyStart = offset + headerEnd;

    if (data.length - bodyStart < contentLength) {
      return null; // need more data
    }

    const body = data.subarray(bodyStart, bodyStart + contentLength).toString();
    const nextOffset = bodyStart + contentLength;

    return { message: body, nextOffset };
  }

  /**
   * Try to parse a newline-delimited JSON message.
   * Returns null if no complete line is available.
   */
  private tryParseNewline(
    data: Buffer,
    offset: number,
  ): { message: string; nextOffset: number } | null {
    const str = data.subarray(offset).toString();
    const nlIdx = str.indexOf('\n');
    if (nlIdx === -1) return null;

    const line = str.substring(0, nlIdx).trim();
    const nextOffset = offset + nlIdx + 1;

    if (line.length === 0) {
      // Skip empty lines — return sentinel for outer loop to handle iteratively (#414)
      return { message: '', nextOffset };
    }

    return { message: line, nextOffset };
  }

  /**
   * Emit a parsed message to the handler.
   */
  private emit(message: string): void {
    if (!message || !this.onMessage) return;
    try {
      const parsed = JSON.parse(message);
      this.onMessage(parsed);
    } catch {
      this.writeError('Parse error');
    }
  }

  /**
   * Write a JSON-RPC error for protocol violations.
   */
  private writeError(message: string): void {
    this.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message },
      }),
    );
  }

  /**
   * Send a response. Throws if transport is closed.
   */
  send(data: unknown): void {
    if (this.closed) {
      throw new Error('Transport is closed');
    }
    this.write(JSON.stringify(data));
  }

  /**
   * Write data to output stream in the detected framing format.
   */
  private write(str: string): void {
    if (this.framing === 'content-length' || this.framing === 'unknown') {
      // Default to Content-Length for unknown framing
      const len = Buffer.byteLength(str, 'utf-8');
      this.output.write(`Content-Length: ${len}\r\n\r\n${str}`);
    } else {
      this.output.write(str + '\n');
    }
  }

  /**
   * Close the transport gracefully.
   */
  close(): void {
    this.closed = true;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private onMessage: ((data: unknown) => void) = () => {};

  /**
   * Set the message handler and start processing.
   */
  on(_event: 'message', handler: (data: unknown) => void): void {
    this.onMessage = handler;
  }
}
