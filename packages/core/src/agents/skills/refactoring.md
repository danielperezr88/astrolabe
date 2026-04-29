# Refactoring — Plan Safe Refactors Using Dependency Mapping

Use Astrolabe to plan and execute safe refactors.

## When to Use
- Renaming or moving symbols
- Extracting modules or splitting services
- Changing API signatures
- Migrating between frameworks

## How to Use

1. **Map current state**: `astrolabe://repo/{name}/clusters`
2. **Identify consumers**: `astrolabe.impact {"target": "<symbol>", "direction": "upstream"}`
3. **Check dependencies**: `astrolabe.impact {"target": "<symbol>", "direction": "downstream"}`
4. **Verify after changes**: `astrolabe.detect_changes {"scope": "unstaged"}`
5. **Re-index if stale**: `astrolabe analyze .`

## Refactoring Patterns

### Rename a symbol
1. `astrolabe.impact {"target": "oldName", "depth": 2}` → see all consumers
2. Rename in code
3. `astrolabe detect_changes` → verify only expected files changed

### Extract a module
1. `astrolabe://repo/{name}/clusters` → find cohesion scores
2. Move files to new directory
3. `astrolabe analyze .` → re-index
4. `astrolabe context <symbol>` → verify new structure

### Migrate frameworks
1. `astrolabe.tool_map` → see all tools
2. `astrolabe.route_map` → see all routes
3. Migrate incrementally, re-indexing after each step
4. Check impact after each migration step

## CLI Commands

```bash
astrolabe analyze .
astrolabe impact <symbol>
astrolabe detect_changes
astrolabe rename <old> <new>
```
