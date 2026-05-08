## Review — PR #538: HTTP server integration tests

### Verdict: ✅ APPROVED — merge when ready

**CI Status**: Ubuntu tests fail with pre-existing `@ladybugdb/core` `spawnSync /bin/sh ENOENT` flake (all 3 Node versions). Windows tests pass on all 3 Node versions. Docker Build pending. Not caused by this PR.

### What looks good

- **20 integration tests** covering all 13 endpoints + middleware — comprehensive.
- **Real HTTP server on port 0** — no port conflicts, proper isolation.
- **`mkdtempSync` for test data** — clean temp directories with `rmSync` in `afterAll`.
- **Registry save/restore** — saves original registry before tests, restores after. Good citizen.
- **Middleware tests** — X-Request-Id generation, preservation, rate limit headers, CORS preflight (204), unknown path (404).
- **Auth tests** — separate server with `apiKey`, tests health skip, no key (401), wrong key (401), correct key (200).
- **Data validation** — tests node/edge counts, FTS search, impact analysis, grep, 400 errors for missing params, 404 for nonexistent repos.
- **Follows existing pattern** — same structure as `eval-server.test.ts`.
- **492 passed (+20 new)** — no regressions.

### Minor observations (non-blocking)

- **`import('node:http')` inside `fetchJson`** — dynamic import on every request. Works fine for tests but could be hoisted to module level for readability.
- **`data` parsing in `fetchJson`** — falls back to raw string on JSON parse error. Good defensive coding.
- **Auth `afterAll` calls `shutdownHttpServer()`** — this shuts down the module-level server, not just the auth server. Since the main test's `afterAll` also does this, it's fine but worth noting.

### Merge notes

- No conflicts with other open issues.
- Safe to merge at any time.
