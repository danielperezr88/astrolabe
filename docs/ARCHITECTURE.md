# Architecture Pitfall Mitigations

This document catalogs known architectural pitfalls identified from GitNexus (issues #1403, #1287, #1273, #1402, #1361, #1358, #1275, #1406, #1413, #1351) and describes how Astrolabe proactively avoids each one.

Referenced by: #643

---

## Pitfall 1: FTS/Vector Indexes Not Persisted to Disk

**GitNexus problem**: FTS indexes were in-memory only, causing empty query results after connection close.

**Astrolabe mitigation**: SQLite FTS5 virtual tables are **persisted on disk** as part of the database file. The `fts.ts` module uses lazy initialization — `ensureIndex()` checks `sqlite_master` before creating the table, and `populateFromNodesTable()` repopulates from the persistent `nodes` table on first access after reopen. An integration test verifies FTS5 queries work after DB close/reopen.

**Code references**:
- `packages/core/src/search/fts.ts` — `ensureIndex()`, `populateFromNodesTable()`
- `packages/core/tests/search/fts.test.ts` — `'queries work after close/reopen (FTS5 persistence)'`

---

## Pitfall 2: Read-Only DB Connection for Queries

**GitNexus problem**: Read-only connections prevented lazy index creation and caused segfaults on macOS arm64.

**Astrolabe mitigation**: Single read-write connection strategy. `createSqliteStore()` opens one connection with `journal_mode = WAL` and `busy_timeout = 5000`. The FTS module shares this connection via `dbOrPath` parameter — if a shared connection is provided, it does not set journal mode (owner controls it). No read-only mode is used anywhere in the codebase.

**Code references**:
- `packages/core/src/persist/sqlite.ts` — `createSqliteStore()`, WAL pragmas
- `packages/core/src/search/fts.ts` — `createFtsSearch(dbOrPath, _store?)`, `ownsConnection` flag

---

## Pitfall 3: WAL Corruption from Concurrent MCP + Analyze

**GitNexus problem**: Running MCP server and `analyze` simultaneously caused WAL corruption due to single-writer architecture.

**Astrolabe mitigation**: Advisory lock file (`astrolabe.lock`) prevents concurrent writes. The CLI `analyze` command calls `acquireDbLock()` before any DB writes and releases in a `finally` block. If another process holds the lock, a descriptive error is thrown. The MCP server runs read-only and does not acquire the lock. SQLite WAL mode + `busy_timeout = 5000` handles concurrent readers. The `withRetrySync`/`withRetry` functions retry on `SQLITE_BUSY` errors.

**Code references**:
- `packages/core/src/persist/lock.ts` — `acquireDbLock()`, `DbLock.release()`
- `packages/cli/src/index.ts` — `acquireDbLock()` call in `analyze` command
- `packages/core/src/persist/sqlite.ts` — `withRetrySync()`, `withRetry()`, `isDbBusyError()`
- README — Concurrency note in Commands section

---

## Pitfall 4: False Negatives in Safety Gates

**GitNexus problem**: Impact analysis reported `LOW` risk for symbols with incomplete call traces, undermining trust.

**Astrolabe mitigation**: All three analysis paths report `UNKNOWN` instead of `LOW` when call traces are incomplete:

1. **`apiImpact()`** — When a handler has routes but no consumers, checks if ANY `CALLS` edges involve the target. If yes: `'UNKNOWN: untraceable callers'`. If no edges at all: `'safe to change'`.
2. **`impact()`** — When `affected` is empty but the target node has relationship edges, returns `risk: 'UNKNOWN'`.
3. **`detectChanges()`** — When changed file symbols exist but no processes are affected, reports `risk_level: 'unknown'` instead of `'low'`.

The principle: **never underestimate blast radius**. If a symbol cannot be fully traced, it is safer to report `UNKNOWN` than `LOW`.

**Code references**:
- `packages/core/src/mcp/api-tools.ts` — `apiImpact()`, lines 248-267
- `packages/core/src/mcp/server.ts` — `impact()`, lines 575-597; `detectChanges()`, lines 663-666

---

## Pitfall 5: Not Truly Offline

**GitNexus problem**: Embeddings required HuggingFace model downloads; DB extensions fetched at runtime; analysis required internet.

**Astrolabe mitigation**: TF-IDF is the **default embedding provider** — no downloads required. The `createEmbeddingProvider('auto')` fallback chain is: remote URL → `@huggingface/transformers` (if installed) → `TfIdfEmbeddingProvider` → dummy 384D zero vector. Transformers.js is opt-in via `ASTROLABE_PROVIDER=transformers`. Remote providers require explicit `ASTROLABE_EMBEDDING_URL`. Analysis works fully offline with TF-IDF.

**Code references**:
- `packages/core/src/search/embeddings-store.ts` — `createEmbeddingProvider()`, `createTfIdfEmbeddingProvider()`, comment at line 349
- `packages/core/src/search/embeddings.ts` — Pure TF-IDF computation, no external dependencies

---

## Pitfall 6: Native Addon Lifecycle Fragility

**GitNexus problem**: N-API native bindings caused segfaults on macOS arm64 when switching DB connection modes. Windows had npm shim resolution issues.

**Astrolabe mitigation**: Only one native addon — `better-sqlite3` — which is well-tested across platforms. `native-preload.js` handles the Electron binary copy issue (#224) by pre-loading the native module before better-sqlite3 tries to find it. CI runs on both Ubuntu and Windows.

**Code references**:
- `packages/core/src/persist/native-preload.js` — Electron binary copy workaround
- `.github/workflows/ci.yml` — Matrix testing on Ubuntu + Windows

---

## Pitfall 7: No Observability

**GitNexus problem**: After indexing 200+ repos, no way to profile performance bottlenecks.

**Astrolabe mitigation**: `PhaseTimer` provides structured timing for pipeline phases and MCP tool handlers. The `--profile` CLI flag enables per-phase timing that emits to stderr. Each MCP tool handler records timing via `PhaseTimer.start()`/`mark()`/`stop()`. The pipeline timer activates when `--profile` is set or `ASTROLABE_DEBUG` is enabled.

**Code references**:
- `packages/core/src/core/phase-timer.ts` — `PhaseTimer` class with `start()`, `mark()`, `stop()`
- `packages/core/src/core/pipeline.ts` — Phase-level timing integration, line 121-155
- `packages/cli/src/index.ts` — `--profile` flag definition, line 55
- `packages/core/src/mcp/server.ts` — Per-tool timing in each handler

---

## Summary Table

| Pitfall | Problem | Mitigation | Status |
|---------|---------|------------|--------|
| 1. FTS persistence | Indexes in-memory only | SQLite FTS5 is disk-persistent; lazy init from `nodes` table | ✅ Verified with test |
| 2. Read-only connection | Segfaults from mode switching | Single read-write connection with WAL mode | ✅ Implemented |
| 3. WAL corruption | Concurrent write corruption | Advisory lock file + WAL + `busy_timeout` + retry | ✅ Implemented |
| 4. False negatives | LOW risk for untraceable symbols | `UNKNOWN` risk level when traces are incomplete | ✅ Implemented |
| 5. Not truly offline | Required model downloads | TF-IDF as default; Transformers.js opt-in | ✅ Implemented |
| 6. Native addon fragility | Segfaults on macOS arm64 | Minimal native addons; `native-preload.js` workaround | ✅ Implemented |
| 7. No observability | No performance profiling | `PhaseTimer` + `--profile` flag | ✅ Implemented |