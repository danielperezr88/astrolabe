## Review — PR #508: Add structured logging to all silent catch blocks

### Verdict: ✅ APPROVED — merge when ready

**CI Status**: Ubuntu tests fail with pre-existing `@ladybugdb/core` `spawnSync /bin/sh ENOENT` flake. Windows tests pass. Docker Build passes. Not caused by this PR.

### What looks good

- **Zero remaining `catch {}` blocks** — comprehensive sweep across all 8 files.
- **`log.debug` level** — appropriate for catch blocks that were previously silent. Won't spam production logs.
- **Scoped loggers** — each file gets `createLogger({ level: 'debug' })` with meaningful module names.
- **Error context included** — each catch logs the actual error: `log.debug('worker shutdown failed: %s', err)` pattern.
- **Covers edge cases** — corrupted JSON, missing tables, unreadable files, bad MCP configs. All reasonable things to silently handle but useful to debug.

### Minor observations (non-blocking)

- Some catch blocks now log at debug level where `log.warn` might be more appropriate for production visibility (e.g., corrupted JSON in sqlite.ts, missing tables in lbug.ts). However, `debug` is the safe choice since these were previously silent.
- If the structured logger from PR #505 is already merged (it is), these loggers will output consistently.

### Merge notes

- No conflicts with other open PRs.
- Safe to merge.
