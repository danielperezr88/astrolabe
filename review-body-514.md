## Review — PR #514: Add CHANGELOG.md with auto-update in release pipeline

### Verdict: ✅ APPROVED — merge after PR #510

**CI Status**: Ubuntu tests fail with pre-existing `@ladybugdb/core` flake. Windows tests pass. Docker Build passes. Not caused by this PR.

### What looks good

- **CHANGELOG.md** — initialized with 0.2.0 entries for all enterprise readiness work. Good starting point.
- **Auto-update in release.yml** — runs `release-notes.mjs` (already exists), prepends under version+date header. Clean automation.
- **Commit + push in CI** — uses the standard `stefanzweifel/git-auto-commit-action` pattern.

### Minor observations (non-blocking)

- **Merge conflict with PR #510** — both modify `release.yml`. #510 adds npm publish step, #514 adds changelog step. Merge #510 first, then rebase this PR.
- **CHANGELOG.md will be auto-committed to main** — ensure the CI bot has write permissions to main (it should, since the release workflow already pushes tags and commits).

### Merge notes

- **MERGE AFTER #510** — both touch `release.yml`. This PR will need a rebase after #510 is merged.
