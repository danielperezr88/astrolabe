## Review: Approved with suggestions

All required CI checks pass (Unit Tests ubuntu/windows, Docker Build, Integration Tests). Coverage Report failure is pre-existing (#498).

### Code Quality ✅

- Clean token-bucket implementation — simple, correct, no external dependencies
- Good middleware ordering: rate limit runs after CORS preflight but before auth
- Health endpoint correctly exempted
- Standard rate limit headers (X-RateLimit-Limit/Remaining/Reset) on every response
- 429 response includes `Retry-After` header and JSON body — good practice

### Suggestions (non-blocking for merge, but should be addressed)

**1. Memory leak — unbounded Map growth**

`rateBuckets` is a `Map<string, RateBucket>` that never evicts entries. In a long-running server, every unique IP address creates a permanent entry. Consider:

```typescript
// Simple cleanup: evict expired buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(ip);
  }
}, 5 * 60_000);
```

Or limit the map size to N entries with LRU eviction.

**2. No env var validation**

```typescript
const limit = parseInt(process.env.ASTROLABE_RATE_LIMIT || String(RATE_LIMIT_DEFAULT), 10);
```

If `ASTROLABE_RATE_LIMIT=abc`, `parseInt` returns `NaN`, and all comparisons with `NaN` are false — meaning the rate limiter would effectively be disabled. Consider:

```typescript
const raw = parseInt(process.env.ASTROLABE_RATE_LIMIT || '', 10);
const limit = Number.isFinite(raw) && raw > 0 ? raw : RATE_LIMIT_DEFAULT;
```

These are non-blocking for merge but worth filing as follow-up issues.

### Merge Conflict Note

This PR and #503 both modify `http-server.ts`. Whichever merges second will need a rebase. The changes are in different parts of the file (rate limiter at line ~70/middleware at line ~693, request ID at line ~622), so the rebase should be clean.
