## Summary
Closes #625

Replaces the fragile regex-based release skip check with a deterministic author check.

## Before
```bash
MSG="${{ github.event.head_commit.message }}"
if echo "$MSG" | head -1 | grep -qE "chore: release v|docs: update CHANGELOG for v"
```

Problems:
- **False positive**: PR body text leaked into squash merge commit, matching the regex pattern
- **False negative**: Format changes in commit messages could bypass the check
- Required `head -1` hack to work around the false positive

## After
```bash
AUTHOR="${{ github.event.head_commit.author.username }}"
if [ "$AUTHOR" = "github-actions[bot]" ]
```

The CHANGELOG step already sets the commit author to `github-actions[bot]`, so checking the author is a deterministic and reliable way to identify automated commits.
