/**
 * Helper subprocess for graceful shutdown integration tests (#535).
 *
 * Starts an HTTP server using startHttpServer, outputs the port on stdout,
 * and relies on the server's built-in SIGTERM/SIGINT handlers for cleanup.
 *
 * Protocol:
 *   1. Starts server on port 0
 *   2. Writes "READY:<port>\n" to stdout
 *   3. Waits for signals (handled by http-server.ts cleanup handler)
 *   4. Exits with code 0 (clean) or 1 (active requests still pending)
 */

import { startHttpServer } from '../../dist/server/http-server.js';
import { saveRegistry } from '../../dist/mcp/registry.js';

// Clear registry so server starts clean
saveRegistry([]);

const server = startHttpServer({ port: 0, host: '127.0.0.1' });

server.on('listening', () => {
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  process.stdout.write(`READY:${port}\n`);
});

// Keep the process alive — the server's own SIGTERM/SIGINT handlers
// (registered inside startHttpServer) will handle cleanup and process.exit().
