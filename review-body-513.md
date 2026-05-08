## Review — PR #513: Add CONTRIBUTING.md and GitHub issue templates

### Verdict: ✅ APPROVED — merge when ready

**CI Status**: Ubuntu tests fail with pre-existing `@ladybugdb/core` flake. Windows tests pass. Docker Build passes. Not caused by this PR (docs-only change).

### What looks good

- **CONTRIBUTING.md** — comprehensive guide covering prerequisites, project structure, branching model, commit style, testing, CI/CD. Well-organized.
- **`bug_report.yml` template** — structured form with description, steps, environment, logs. Good for reproducible reports.
- **`feature_request.yml` template** — problem/solution/alternatives format. Forces requesters to think about the "why".
- **`config.yml`** — disables blank issues, redirects to existing issue forms. Prevents low-quality submissions.
- **Matches existing CLAUDE.md conventions** — branching model, commit prefixes, and PR workflow are consistent.

### Minor observations (non-blocking)

- CONTRIBUTING.md references the branching model (`feature/* → staging → main`) which is accurate per CLAUDE.md.
- Issue templates use YAML form format — good choice over markdown templates for structured data.

### Merge notes

- No conflicts with any open PRs.
- Safe to merge at any time.
