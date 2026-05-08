## Review — PR #546: MCP server end-to-end integration tests

### Verdict: ❌ CHANGES REQUESTED — Windows tests fail with timeout

**CI Status**: 
- Ubuntu: Pre-existing `@ladybugdb/core` flake (not this PR's fault)
- **Windows: `tests/mcp/mcp-server.test.ts` FAILS** — `beforeAll` times out at line 61 during `sendRpc('initialize')`. The MCP server subprocess isn't responding within the 15s timeout on Windows.
- Docker Build: Passes

### The problem

The `beforeAll` hook spawns the MCP server subprocess, sends an `initialize` JSON-RPC request, and waits for a response. On Windows CI, the subprocess never responds — all 9 tests show as "9 skipped" (because `beforeAll` failed, the test suite was skipped).

This is likely because:
1. The subprocess import path (`../../dist/mcp/server.js`) may not resolve correctly on Windows (backslash path separators)
2. The MCP server may be writing to stderr instead of stdout on Windows
3. The subprocess may need more time to start on Windows CI runners

### What looks good (code-wise)

- **Subprocess-based testing** — correct approach for MCP stdio transport.
- **Newline-delimited JSON framing** — matches MCP spec.
- **`pendingResolvers` pattern** — clean request/response correlation by message ID.
- **Full pipeline coverage** — protocol (tools/list, unknown method) + tool dispatch (list_repos, query, context, impact, unknown tool).
- **Parameter validation tests** — query requires `query`, context requires `name`.

### What needs to change

1. **Fix Windows subprocess initialization** — investigate why `mcp-server-helper.mjs` doesn't respond on Windows. Common fixes:
   - Use `path.resolve()` for the helper path instead of `join(__dirname, ...)`
   - Add stderr output logging to the test for debugging
   - Increase the `beforeAll` timeout (currently 15000ms — try 30000ms)
   - Ensure the subprocess `env` includes `PATH` and `NODE_ENV`

2. **Consider adding a readiness signal** — have the helper write `"READY\n"` to stdout before the MCP server starts accepting requests, similar to the graceful-shutdown helper's pattern.

Please investigate the Windows timeout and push a fix. Happy to re-review once CI is green.
