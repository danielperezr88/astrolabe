# Impact Analysis — Analyze Blast Radius Before Changes

Use Astrolabe to calculate the impact of your changes before committing.

## When to Use
- Before modifying an exported/public function
- Before deleting or renaming a symbol
- Before refactoring critical paths

## How to Use

1. **Pre-commit check**: `astrolabe.impact {"scope": "unstaged"}`
2. **Symbol-level**: `astrolabe.impact {"target": "<function>", "depth": 3}`
3. **Route-level**: `astrolabe.api_impact {"name": "<handler>"}`
4. **Tool-level**: `astrolabe.tool_map` to see which tools are used
5. **Verify changes**: `astrolabe.detect_changes {"scope": "unstaged"}`

## Risk Levels

| Risk | Meaning | Action |
|------|---------|--------|
| LOW | No consumers found | Safe to change |
| MEDIUM | Internal callers only | Add tests |
| HIGH | Exported callers exist | Check consumers carefully |
| WILL BREAK | Breaking change detected | Do NOT proceed without migration plan |

## CLI Commands

```bash
astrolabe impact <symbol>
astrolabe detect_changes
```
