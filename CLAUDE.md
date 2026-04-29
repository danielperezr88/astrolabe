# CLAUDE.md — Astrolabe Development Instructions

## Core Directive

**Never wait for directions. Never go idle. Work relentlessly.**

- Don't ask for validation or guidance. Comment on issues if unclear, jump to next one, let reviewer respond async.
- Always push when ready. Don't ask "should I push?"
- Set a 10-minute deferred `gh issue list` check when expecting reviewer feedback.

## Priority Order

1. **Bugs first** — critical → moderate → minor. Fix with real code changes, not bulk-closing.
2. **Security fixes** — after bugs.
3. **Code smells / performance** — after security.
4. **Enhancements** — bigger-footprint features over smaller-footprint ones.

## Workflow

- Check `gh issue list --repo danielperezr88/astrolabe --state open` for what to do next.
- Work 1-by-1: read issue → implement fix → run `npm test` → commit → push → next.
- All 148 tests must pass (1 skipped is OK, pre-existing).
- Commit style: `fix:` for bugs, `feat:` for features, reference issue numbers.
- Push to `origin/main` directly.

## Reviewer

A reviewer agent works in 10-minute rounds: fetches latest commits, reviews, files new issues, closes verified ones.
- If no new issues for 40+ minutes, reviewer may be done.
- All non-enhancement issues are filed by the reviewer — trust their analysis.

## Key Commands

```bash
npm test                    # 148 pass, 1 skipped
gh issue list --repo danielperezr88/astrolabe --state open --limit 50 --json number,title,labels
gh issue view <N> --repo danielperezr88/astrolabe --json body
```

## Repository

- `packages/core/` — engine: graph, pipeline, phases, MCP, persistence, search, hooks, setup
- `packages/cli/` — CLI commands: analyze, query, context, impact, groups, setup
- `packages/vscode/` — VSCode extension: webview, extension activation
- `packages/shared/` — shared type definitions
