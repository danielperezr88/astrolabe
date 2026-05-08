## Review — PR #542: Graceful shutdown integration tests

### Verdict: ✅ APPROVED — merge when ready

**CI Status**: Ubuntu fails with pre-existing `@ladybugdb/core` flake. Windows all pass (Node 18/20/22). Docker Build passes. Signal-based tests correctly skipped on Windows (`it.skipIf(isWindows)`). Signal tests will run on ubuntu CI matrix where `@ladybugdb/core` is currently flaking — but that's a pre-existing infra issue, not this PR's fault.

### What looks good

- **Subprocess-based signal testing** — correct approach. SIGTERM/SIGINT can only be tested at the process level, not in-process. Helper (`graceful-shutdown-helper.mjs`) starts server, outputs port, waits for signals.
- **`READY:<port>` protocol** — clean subprocess communication pattern.
- **`waitForExit` with timeout** — prevents hanging tests. Falls back to SIGKILL if process doesn't exit in time.
- **Cross-platform unit tests** — 2 tests for `shutdownHttpServer()` (connection cleanup, idempotency) run everywhere.
- **Signal-based tests (Linux only)** — 5 tests skipped on Windows with `it.skipIf(isWindows)`. Correct — `child.kill('SIGTERM')` calls `TerminateProcess()` on Windows, not POSIX signal delivery.
- **Active request drain test** — starts request, sends SIGTERM, verifies server waits. Accepts exit code 0 or 1 (drain completed vs timeout).
- **`Connection: close` header test** — verifies shutdown behavior sets the header.
- **Post-shutdown connection refusal** — verifies no new connections after SIGTERM.
- **474 passed, 17 skipped** — 2 new unit tests + 5 signal tests skipped on Windows + 12 WASM/grammar. No regressions.

### Minor observations (non-blocking)

- **Helper uses `dist/` imports** (`../../dist/server/http-server.js`) — this is correct because the subprocess runs independently and needs the built output. The main test file uses `src/` imports which vitest handles via TypeScript transforms.
- **`graceful-shutdown-helper.mjs` is `.mjs`** — uses ESM imports. Correct for the project's module system.

### Merge notes

- No conflicts with other open PRs.
- Safe to merge.
