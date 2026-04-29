# Debugging — Trace Bugs Through Call Chains

Use Astrolabe to follow bug symptoms to root causes.

## When to Use
- Reproducing a bug but don't know the cause
- Need to understand the full call chain of a function
- Verifying that your fix doesn't break callers

## How to Use

1. **Find the symbol**: `astrolabe.query {"query": "<function name>"}`
2. **Get call chain**: `astrolabe.context {"name": "<function>"}`
3. **Check callers**: `astrolabe.impact {"target": "<function>", "direction": "upstream"}`
4. **Check callees**: `astrolabe.impact {"target": "<function>", "direction": "downstream"}`
5. **Cross-repo search**: `astrolabe.group_query {"name": "<group>", "query": "<term>"}`

## Pro Tips

- Run `astrolabe.context` before editing ANY function
- Check for HIGH/WILL BREAK in impact results
- Use `astrolabe.detect_changes` after fixing to verify impact

## CLI Commands

```bash
astrolabe context <function>
astrolabe impact <function>
astrolabe query "error handler"
```
