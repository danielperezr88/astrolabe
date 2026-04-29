# Exploring — Navigate Unfamiliar Code

Use Astrolabe to understand codebase structure before editing.

## When to Use
- First time in a codebase
- Need to understand how modules connect
- Looking for entry points or key files

## How to Use

1. **Get repo overview**: `astrolabe://repo/{name}/context`
2. **Find functional areas**: `astrolabe://repo/{name}/clusters`
3. **Search for symbols**: `astrolabe.query {"query": "<keyword>"}`
4. **360° view of a symbol**: `astrolabe.context {"name": "<symbol>"}`
5. **Trace execution flows**: `astrolabe://repo/{name}/processes`

## MCP Tools

- `astrolabe.query` — Hybrid search (keyword + semantic)  
- `astrolabe.context` — Symbol details with incoming/outgoing edges
- `astrolabe.filter_by_label` — Filter graph by node type
- `astrolabe.route_map` — Map HTTP routes to handlers

## CLI Commands

```bash
astrolabe query "auth handler"
astrolabe context loginHandler
astrolabe status
```
