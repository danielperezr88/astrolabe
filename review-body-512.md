## Review — PR #512: Remove temp files and packages/web workspace

### Verdict: ✅ APPROVED — merge when ready

**CI Status**: Ubuntu tests fail with pre-existing `@ladybugdb/core` flake. Windows tests pass. Docker Build passes. Not caused by this PR.

### What looks good

- **Removes dead `packages/web/`** — was a non-functional React scaffold. Release pipeline already didn't reference it (bug #499 was fixed in PR #504).
- **Removes tracked temp files** — `temp_parser_test.txt` and `temp_test_output.txt` should never have been committed.
- **Adds `temp_*.txt` to `.gitignore`** — prevents future temp file leaks.
- **Cleans workspace array** — removes `packages/web` from root `package.json` workspaces.

### Minor observations (non-blocking)

- **10 files deleted** — `packages/web/` had `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/App.tsx`, `src/main.tsx`, `src/App.css`, `src/components/GraphView.tsx`, `src/services/api.ts`, `src/types.ts`. All non-functional scaffold, safe to remove.
- If anyone was planning to revive the web visualization, they can restore from git history.

### Merge notes

- No conflicts with other open PRs.
- **Merge this first** — removes dead code that other PRs don't depend on.
