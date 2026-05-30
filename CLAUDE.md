# CLAUDE.md — Astrolabe Development Instructions

## Core Directive

**Never wait for directions. Never go idle. Work relentlessly. There is ALWAYS more to do.**

Going idle is not acceptable — every idle moment is lost opportunity. If you genuinely run out of new work, cycle back through:
1. Check for new reviewer comments on all open PRs
2. Check for new issues filed since last scan
3. Check if any merged-to-staging PRs are ready for a staging→main release PR
4. Re-read all open issues — you may have missed detail or new context from merged PRs changes what's needed
5. If truly everything is blocked/waiting, set a 10-minute deferred wake-up: `bash("sleep 600 && gh issue list --repo danielperezr88/astrolabe --state open --json number,title,labels")` then IMMEDIATELY go back to step 1 after waking. Never end your turn without either doing work or setting a deferred check.

- Don't ask for validation or guidance. Comment on issues if unclear, jump to next one, let reviewer respond async.
- Always push when ready. Don't ask "should I push?"
- Set a 10-minute deferred `gh issue list` check when expecting reviewer feedback — never just stop and wait.

## Release Flow is MANDATORY (ABSOLUTE — NO EXCEPTIONS)

**Every change must flow through staging. There is no bypass for any reason — not for emergencies, not for security fixes, not for admin pushes.**

```
feature/fix-xxx ──PR──▶ staging ──PR──▶ main
```

- **Push to staging** triggers `rc.yml`: tests → auto version bump → Docker RC image → GitHub pre-release
- **Push to main** triggers `release.yml`: integration test gate → stable Docker image → GitHub release with notes → npm publish
- **Skipping staging means**: no RC, no auto version bump, no release notes generation, release pipeline breaks on duplicate versions

### What Happens When You Bypass Staging (The Mess You Create)

1. `main` gets commits that `staging` doesn't have → branches diverge
2. Release pipeline fails because version already exists on npm (no auto-bump)
3. Docker image gets pushed but GitHub release is stale
4. npm package is out of sync with the actual code
5. Manual cleanup required: sync staging, create proper PR, re-trigger release

**If you bypassed staging (even as admin), you MUST:**
1. Sync staging with main: `git checkout staging && git merge main && git push`
2. Create PR from `staging` → `main` (this triggers the proper release pipeline)
3. Never push directly again

## Priority Order

1. **Bugs first** — critical → moderate → minor. Fix with real code changes, not bulk-closing.
2. **Security fixes** — after bugs.
3. **Code smells / performance** — after security.
4. **Enhancements** — bigger-footprint features over smaller-footprint ones.

## Branching Model

```
feature/fix-xxx ──PR──▶ staging (auto RC) ──PR──▶ main (stable release)
```

### Branches

| Branch | Purpose | Protection |
|--------|---------|------------|
| `main` | Stable releases only | PR required, 1 approval, status checks must pass, linear history |
| `staging` | Release candidate integration | PR required, 1 approval, status checks must pass, linear history |
| `feature/*`, `fix/*` | Short-lived work branches | No protection — create, push, delete freely |

### Rules

- **NEVER push directly to `main` or `staging`. Always go through PRs.** See [Release Flow is MANDATORY](#release-flow-is-mandatory-absolute--no-exceptions) above.
- **Admin bypass does not exist.** Even if you can force-push as admin, you must not. The release flow is the only path. **Never use `--admin` flag on `gh pr merge`.** PRs that lack approval MUST wait for the reviewer — do not self-approve or bypass.
- All PRs require passing status checks: unit tests (ubuntu + windows), integration tests (main only), Docker build validation.
- All PRs require at least 1 approval. Stale reviews are auto-dismissed on new pushes.
- Use linear history (no merge commits). Rebase or squash-merge.

## Workflow

1. Check `gh issue list --repo danielperezr88/astrolabe --state open` for what to do next.
2. Create a feature branch: `git checkout -b fix/issue-123-description origin/staging`
3. **Immediately open a draft PR** to `staging`: `gh pr create --base staging --draft --title "fix: description (#123)"` — this signals work is in progress and links the issue to the PR.
4. Work 1-by-1: read issue → implement fix → run `npm test` → commit.
5. Push feature branch: `git push -u origin fix/issue-123-description`
6. When ready for review, **mark PR as ready**: `gh pr ready <number>` — removes draft status.
7. Wait for checks to pass and approval, then merge.
8. When staging is ready for release, open PR from `staging` → `main`.
9. Merge triggers the release pipeline automatically.

### Issue-PR Linking

- Every PR **must** reference its issue in the title or body: `fix: description (#123)` or `Closes #123`.
- Use GitHub's keywords (`Closes`, `Fixes`, `Resolves`) in the PR body to auto-close issues on merge.
- Draft PRs should be created immediately when starting work on an issue — don't wait until implementation is complete.
- If an issue has no linked draft PR, it's considered unassigned / up for grabs.

### Commit Style

- Prefix with `fix:`, `feat:`, `refactor:`, `docs:`, `test:`, or `chore:`
- Reference issue number: `fix: resolve auth crash (#42)`
- Keep commits atomic — one logical change per commit

## CI/CD Pipelines

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push/PR to `main` or `staging` | Unit tests (ubuntu + windows), integration tests, coverage report on PRs |
| `docker.yml` | PR to `main` or `staging` | Docker build validation (no push) |
| `rc.yml` | Push to `staging` | Tests → auto version bump → Docker RC image → GitHub pre-release |
| `release.yml` | Push to `main` | Integration test gate → stable Docker image → GitHub release with notes |

## Release Process

### Automatic (minor versions)

1. Feature branches merge into `staging` via PR.
2. Each merge to `staging` triggers `rc.yml`: builds an RC Docker image (e.g. `0.2.0-rc.1`), creates a GitHub pre-release.
3. Subsequent merges increment the RC number (`0.2.0-rc.2`, `0.2.0-rc.3`, ...).
4. When ready, open PR from `staging` → `main`. Merge triggers `release.yml`.
5. Release pipeline: integration tests gatekeep → stable Docker image (`latest` + version tag) → GitHub release with auto-generated notes.

### Major version bump

To start a new major version cycle, create a seed tag:

```bash
git tag v2.0.0-rc.seed
git push origin v2.0.0-rc.seed
```

All subsequent RCs and the release will use `2.0.0.x` instead of auto-minor-bumping from the current stable.

### Version calculation

Uses `scripts/next-version.mjs`:
- `--rc` → next RC version (minor bump from latest stable, or increment existing RC)
- `--release` → stable version (strips -rc.N suffix from latest RC)
- `--current` → current stable version

### Release notes

Auto-generated by `scripts/release-notes.mjs` from conventional commits between the last stable tag and HEAD. Grouped by type: Features, Bug Fixes, Refactoring, Performance, etc.

## Release Artifacts

- **Docker image**: `ghcr.io/danielperezr88/astrolabe` — tags: `latest`, `stable`, semver (`0.2.0`, `0.2`)
- **GitHub Release**: with auto-generated notes, Docker pull instructions, contributor list
- **npm** (`@astrolabe/cli`): package.json versions bumped automatically by release pipeline

## Key Commands

```bash
npm test                    # 676 pass, 19 skipped (WASM/grammar)
npm run build --workspace packages/shared  # Must run before core build
gh issue list --repo danielperezr88/astrolabe --state open --limit 50 --json number,title,labels
gh issue view <N> --repo danielperezr88/astrolabe --json body
gh pr list --repo danielperezr88/astrolabe --state open --json number,title,headRefName
gh pr view <N> --repo danielperezr88/astrolabe --json reviews,comments
node scripts/next-version.mjs --rc         # Check next RC version
node scripts/next-version.mjs --release    # Check next stable version
node scripts/next-version.mjs --current    # Check current stable version
```

## Reviewer

A reviewer agent works in 10-minute rounds: reviews open PRs, pushes back with change requests, approves when ready.
- Reviewer **does NOT file bug issues** — instead, pushes back directly on PRs (request changes, comment with findings).
- If reviewer finds issues not tied to an existing PR, they may file an issue first, then reference it in their PR review.
- Reviewer follows the same branching model: creates feature branches, opens draft PRs, links PRs to issues.
- Reviewer marks PRs as ready for review after implementation is complete and tests pass.
- The implementer and reviewer coordinate via GitHub issues AND PR reviews — no direct push to protected branches.
- **Always check PR reviews**: `gh pr view <number> --repo danielperezr88/astrolabe --json reviews,comments` — fix any reviewer feedback before merging.
- **When waiting for review**: Set a 10-minute deferred check (`gh pr view <N> --json reviewDecision`) to poll for reviewer approval. Never admin-merge to bypass the review requirement.

## Repository

- `packages/core/` — engine: graph, pipeline, phases, MCP, persistence, search, hooks, setup
- `packages/cli/` — CLI commands: analyze, query, context, impact, groups, setup
- `packages/vscode/` — VSCode extension: webview, extension activation
- `packages/shared/` — shared type definitions and cross-platform utilities
- `scripts/next-version.mjs` — semver calculation for RC and release pipelines
- `scripts/release-notes.mjs` — conventional commit grouping for release notes
