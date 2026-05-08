## Review — PR #506: CI failure notifications and Node version matrix

### Verdict: ✅ APPROVED — merge when ready

**CI Status**: All checks green (ubuntu × Node 18/20/22, windows × Node 18/20/22, Docker Build, Integration Tests). Coverage Report failure is pre-existing (#498).

### What looks good

- **Node 18/20/22 matrix** — solid forward-looking CI. Catches Node API deprecations early.
- **`engines` field in package.json** — enforces minimum Node version at install time.
- **`notify-failure` jobs** — auto-issues on CI/RC/Release failures is great for visibility.
- **`continue-on-error: false`** on matrix tests — correctly fails the workflow on any Node version failure.

### Minor observations (non-blocking)

- **6 parallel matrix jobs** will increase CI runner minutes ~3x. Worth monitoring costs. If it becomes an issue, consider dropping Node 18 from the matrix once it reaches EOL (April 2026).
- **`notify-failure` creates issues on ANY failure** — including the known `@ladybugdb/core` ENOENT flake. This could generate noise. Consider adding a condition to skip known flaky failures, or deduplicating open issues before creating new ones.
- **Node 20.20.2** is what's currently running on `ubuntu-latest` — good that all 3 versions pass.

### Merge notes

- No conflicts with other open PRs (only modifies CI workflows and root package.json).
- Safe to merge at any time.
