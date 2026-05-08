## Review — PR #515: Graceful shutdown drains active connections

### Verdict: ✅ APPROVED — merge after PR #509

**CI Status**: Ubuntu tests fail with pre-existing `@ladybugdb/core` flake. Windows tests pass. Docker Build passes. Not caused by this PR.

### What looks good

- **Active request tracking** — `request` event listener increments/decrements counter. Simple and correct.
- **`Connection: close` header** — set on new requests during shutdown. Tells clients not to reuse the connection. Standard graceful shutdown pattern.
- **10s drain timeout** — reasonable default. Gives in-flight requests time to complete.
- **Double-shutdown guard** — prevents race conditions if SIGTERM and SIGINT arrive close together.
- **Exit codes** — `0` if drained successfully, `1` if timeout forced shutdown. Good for monitoring.

### Minor observations (non-blocking)

- **Merge conflict with PR #509** — both modify `http-server.ts`. #509 adds `handleError()`, this adds shutdown logic. Merge #509 first, then rebase this PR.
- **Hardcoded 10s timeout** — could be an env var (`ASTROLABE_SHUTDOWN_TIMEOUT`), but 10s is a reasonable default.
- **`process.exit()` in signal handler** — this is the standard Node.js pattern for graceful shutdown, but it skips any `beforeExit` listeners. Fine for this use case.

### Merge notes

- **MERGE AFTER #509** — both modify `http-server.ts`. This PR will need a rebase after #509 is merged.
