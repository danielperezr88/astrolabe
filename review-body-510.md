## Review — PR #510: Add npm publish step to release pipeline

### Verdict: ✅ APPROVED — merge when ready

**CI Status**: Ubuntu tests fail with pre-existing `@ladybugdb/core` flake. Windows tests pass. Docker Build passes. Not caused by this PR.

### What looks good

- **Builds before publish** — `npm run build --workspace packages/shared && ... core && ... cli` ensures artifacts are fresh.
- **`.npmrc` with `NODE_AUTH_TOKEN`** — standard pattern for CI npm auth. Token comes from GitHub secret, never hardcoded.
- **`publishConfig.access: 'public'`** — correct for scoped packages (default is restricted).
- **Runs in release workflow** — only publishes on main push, not on RC. Correct.

### Minor observations (non-blocking)

- **`NPM_TOKEN` secret must be configured** — the PR description mentions this prerequisite. If the secret is missing, the publish step will fail silently (or with an auth error). Make sure to add it before the next release.
- **No `--access public` flag in the `npm publish` command** — relies on `publishConfig` in package.json instead. Both approaches work; `publishConfig` is the correct long-term solution.
- **Merge conflict with PR #514** — both modify `release.yml`. Merge this one first, then rebase #514.

### Merge notes

- **MERGE #510 BEFORE #514** — both modify `release.yml`. #514 adds a changelog step; #510 adds npm publish. Order matters less here but a rebase will be needed.
- **Action required before next release**: Add `NPM_TOKEN` secret to repo settings.
