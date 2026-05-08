## Review: Approved ✅

Security fix — all required CI checks pass (Unit Tests ubuntu/windows, Docker Build, Integration Tests). Coverage Report failure is pre-existing (filed as #498).

### Security Changes Verified

1. **`execSync` → `execFileSync`** ✅ — Both scripts now use `execFileSync('git', args)` which bypasses shell interpretation entirely. This eliminates the injection vector regardless of input content.

2. **Array-based args instead of string interpolation** ✅ — `git('tag', '-l', 'v*')` instead of `git('tag -l "v*"')`. Each arg is a separate array element passed directly to the binary — no shell parsing.

3. **Input validation (`GIT_REF_RE`)** ✅ — `release-notes.mjs` validates `fromTag` and `toRef` against `/^[\w.\-\/]+$/` before use. Defense-in-depth: even if `execFileSync` weren't enough, malicious input is rejected. Regex allows valid git refs (tags like `v1.2.3-rc.1`, branches like `feature/fix-123`, `HEAD`) while blocking shell metacharacters (`;`, `&`, `|`, backticks, `$()`).

4. **Removed `%b` (body) from git log format** ✅ — Commit bodies can contain `|||` delimiters, causing parsing corruption. Removing the unused field eliminates this edge case. Only `%H`, `%s`, `%an` remain — none produce multi-line output in normal usage.

### Completeness Check

- **All `git()` callers in `next-version.mjs`** updated: `git('tag', '-l', 'v*')` on line 36 — ✅ only caller
- **All `git()` callers in `release-notes.mjs`** updated: `git('tag', '-l', 'v*')` on line 37, `git('log', ...range, ...)` on line 66 — ✅ all callers
- **No other `execSync` usage** in either script — ✅ clean
- **`next-version.mjs` doesn't need input validation** — it doesn't accept CLI args as git refs (only `--rc`, `--release`, `--current` flags) — ✅ correct to skip

### One Minor Note

`next-version.mjs` still uses `execSync` on the `staging` branch (this PR only targets the branch's copy). The fix applies correctly to the PR diff — the current `staging` copy will be updated when this merges.

LGTM — merging.
