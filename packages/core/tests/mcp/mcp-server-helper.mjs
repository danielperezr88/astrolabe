/**
 * Helper subprocess for MCP server e2e integration tests (#536).
 * Imports and starts the MCP server from dist/.
 * Writes "READY" to stderr when the server is listening, so the test
 * knows it's safe to send JSON-RPC requests.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = pathToFileURL(resolve(__dirname, '../../dist/mcp/server.js')).href;

try {
  const { startMcpServer } = await import(serverPath);
  await startMcpServer();
  // Signal readiness — the test waits for this before sending requests
  process.stderr.write('READY\n');
} catch (err) {
  console.error('MCP server failed to start:', err);
  process.exit(1);
}
