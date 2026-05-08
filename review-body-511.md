## Review — PR #511: Add .env.example with documented environment variables

### Verdict: ✅ APPROVED — merge when ready

**CI Status**: Ubuntu tests fail with pre-existing `@ladybugdb/core` flake. Windows tests pass. Docker Build passes. Not caused by this PR (docs-only change).

### What looks good

- **13 env vars documented** — comprehensive coverage of auth, LLM, embeddings, HTTP, analysis, and debug configs.
- **`!.env.example` gitignore rule** — correctly allows the example file while keeping `.env.*` ignored.
- **Descriptions with defaults** — each variable has a comment explaining its purpose. Good DX.
- **No code changes** — pure documentation, zero risk.

### Nothing to flag. Clean docs PR.

### Merge notes

- No conflicts with any open PRs.
- Safe to merge at any time.
