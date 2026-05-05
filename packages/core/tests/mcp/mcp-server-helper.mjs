/**
 * Helper subprocess for MCP server e2e integration tests (#536).
 * Imports and starts the MCP server from dist/.
 */

import { startMcpServer } from '../../dist/mcp/server.js';

startMcpServer().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
