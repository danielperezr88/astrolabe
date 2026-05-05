# Contributing to Astrolabe

Thanks for your interest in contributing! This guide covers the essentials.

## Quick Start

```bash
git clone https://github.com/danielperezr88/astrolabe.git
cd astrolabe
npm install            # Installs all workspace dependencies
npm run build          # Builds shared → core → cli → vscode
npm test               # Runs core package tests (vitest)
```

## Prerequisites

- **Node.js** 18+ (tested on 18, 20, 22)
- **npm** 9+ (workspaces support required)

## Project Structure

```
packages/
  shared/   — Type definitions and cross-platform utilities
  core/     — Engine: graph, pipeline, phases, MCP, persistence, search
  cli/      — CLI commands: analyze, query, context, impact, groups, setup
  vscode/   — VSCode extension: webview, extension activation
scripts/    — CI helpers: next-version.mjs, release-notes.mjs
```

## Development Workflow

### 1. Find or create an issue

All work starts with a GitHub issue. Check [open issues](https://github.com/danielperezr88/astrolabe/issues) for something to pick up, or file a new one.

### 2. Create a feature branch

```bash
git checkout -b fix/issue-123-description origin/staging
```

Branch naming: `fix/`, `feat/`, `refactor/`, `docs/`, `test/`, `chore/` + issue number + short description.

### 3. Open a draft PR immediately

```bash
gh pr create --base staging --draft --title "fix: description (#123)"
```

This signals work is in progress and links the issue.

### 4. Implement, test, push

```bash
# Make changes, then:
npm test               # 472 passing required
git add -A
git commit -m "fix: resolve auth crash (#42)"
git push -u origin fix/issue-123-description
```

### 5. Mark PR ready for review

```bash
gh pr ready <number>
```

### 6. Address review feedback

Check for reviewer comments:
```bash
gh pr view <number> --json reviews,comments
```

## Commit Style

- Prefix: `fix:`, `feat:`, `refactor:`, `docs:`, `test:`, `chore:`
- Reference issue: `fix: resolve auth crash (#42)`
- One logical change per commit

## Branching Model

```
feature/fix-xxx ──PR──▶ staging (auto RC) ──PR──▶ main (stable release)
```

- **NEVER** push directly to `main` or `staging`
- All PRs target `staging` (for features/fixes) or `main` (for releases)
- PRs require 1 approval and passing CI checks

## Testing

```bash
npm test                    # Unit tests (472 pass, 12 skipped)
npm run build --workspace packages/shared   # Must run before core build
```

Tests run in CI on both Ubuntu and Windows, across Node 18/20/22.

## CI/CD

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push/PR to main/staging | Unit tests, coverage report |
| `docker.yml` | PR to main/staging | Docker build validation |
| `rc.yml` | Push to staging | RC Docker image + GitHub pre-release |
| `release.yml` | Push to main | Stable Docker image + npm publish + GitHub release |

## Key Commands

```bash
npm test                    # Run all tests
npm run build               # Build all packages
npm run build -w packages/core   # Build specific workspace
node scripts/next-version.mjs --rc       # Check next RC version
node scripts/next-version.mjs --release  # Check next stable version
```

## Questions?

Open an issue at https://github.com/danielperezr88/astrolabe/issues/new
