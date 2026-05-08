## Review — PR #509: Custom error type hierarchy for API responses

### Verdict: ✅ APPROVED — merge when ready

**CI Status**: Ubuntu tests fail with pre-existing `@ladybugdb/core` flake. Windows tests pass. Docker Build passes. Not caused by this PR.

### What looks good

- **Clean inheritance hierarchy** — `AstrolabeError` base with `code`, `statusCode`, `details`, `toJSON()`. Well-designed.
- **Sensible default status codes** — ParseError(422), GraphError(500), QueryError(400), NotFoundError(404), AnalysisError(500), ConfigError(400). Matches HTTP semantics.
- **`isAstrolabeError()` type guard** — proper TypeScript narrowing pattern.
- **`handleError()` in http-server.ts** — centralizes error→response mapping. Falls back to `INTERNAL_ERROR` for unknown errors.
- **Machine-readable `code` field** — `'PARSE_ERROR'`, `'GRAPH_ERROR'`, etc. Good for API consumers.
- **Exported from `@astrolabe/shared`** — available across all packages.

### Minor observations (non-blocking)

- **No `message` field in `toJSON()` output** — `details` is included but the error `message` is not. Consider adding it for client-side debugging, or leave as-is to avoid leaking internals.
- **`handleError()` could be moved to a shared util** — currently lives in http-server.ts but would be useful for eval-server.ts too.
- **Merge conflict with PR #515** — both modify `http-server.ts`. Merge this one first, then rebase #515.

### Merge notes

- **MERGE #509 BEFORE #515** — both modify `http-server.ts`. This one adds `handleError()`, #515 adds graceful shutdown. #515 will need a rebase after this is merged.
