# Astrolabe

**Codebase knowledge graph engine** — multi-language static analysis with graph persistence, community detection, and hybrid search.

Astrolabe builds a rich knowledge graph of your codebase by parsing 15+ languages via tree-sitter. It understands function calls, class hierarchies, imports, routes, ORM models, and structural relationships, then persists everything to SQLite for fast querying.

```
npm install -g @astrolabe/cli
astrolabe analyze .
astrolabe query "authenticate"
```

## Packages

| Package | Description |
|---------|-------------|
| [`@astrolabe/core`](./packages/core) | Knowledge graph engine — parsing, phases, persistence, MCP server |
| [`@astrolabe/cli`](./packages/cli) | Command-line interface (`astrolabe` command) |
| [`@astrolabe/shared`](./packages/shared) | Type definitions shared across packages |
| [`astrolabe-vscode`](./packages/vscode) | VS Code extension — interactive graph exploration |

## Installation

### For Users (Normal / Bundled)

```bash
# Install globally from npm (when published)
npm install -g @astrolabe/cli

# Or clone and build from source
git clone https://github.com/danielperezr88/astrolabe.git
cd astrolabe
npm install
npm run build
npm link     # Makes `astrolabe` available globally
```

### For Collaborators (Editable)

```bash
git clone https://github.com/danielperezr88/astrolabe.git
cd astrolabe
npm install        # Installs all workspace dependencies
npm run build      # Builds shared → core → cli → vscode
```

Workspace packages use TypeScript project references (`tsc -b`). After making changes, rebuild with `npm run build`.

**Running tests:**

```bash
npm test           # Runs core package tests (vitest, 142 tests)
```

### VS Code Extension (Editable / Development)

For development, install the extension as a symlink so changes to `packages/vscode/src/extension.ts` take effect on reload:

```bash
# 1. Build dependencies first
npm run build

# 2. Create a symlink in VS Code extensions directory
#    Windows (PowerShell as Administrator):
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.vscode\extensions\astrolabe-vscode" -Target (Resolve-Path packages/vscode)

#    macOS / Linux:
ln -s $(pwd)/packages/vscode ~/.vscode/extensions/astrolabe-vscode

# 3. After editing extension.ts, rebuild:
npm run build -w packages/vscode

# 4. Reload VS Code: Ctrl+Shift+P → "Developer: Reload Window"
```

Alternatively, open the `packages/vscode` folder in VS Code and press F5 (Extension Development Host).

## MCP Integration

Astrolabe provides a Model Context Protocol server for AI assistant integration (Claude, Cursor, etc.):

### Configuration

Add to your MCP client configuration (`claude_desktop_config.json`, `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "astrolabe": {
      "command": "npx",
      "args": ["-y", "@astrolabe/cli", "serve-mcp"]
    }
  }
}
```

Or point to your local checkout:

```json
{
  "mcpServers": {
    "astrolabe": {
      "command": "node",
      "args": ["/path/to/astrolabe/packages/cli/dist/index.js", "serve-mcp"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `astrolabe.list_repos` | List all indexed repositories |
| `astrolabe.query` | Hybrid search over the knowledge graph |
| `astrolabe.context` | 360-degree symbol view (incoming/outgoing edges, processes) |
| `astrolabe.impact` | Blast radius analysis — upstream/downstream impact |
| `astrolabe.detect_changes` | Git-diff based impact mapping |
| `astrolabe.rename` | Graph-assisted multi-file symbol rename |
| `astrolabe.cypher` | Cypher-like graph pattern queries |

### Index a Repository for MCP

```bash
astrolabe analyze /path/to/repo
```

The repo is added to the global registry (`~/.astrolabe/registry.json`) and becomes queryable via MCP.

## Skill Generation

Generate a Markdown skill file for AI assistants that describes Astrolabe's capabilities:

```bash
astrolabe generate-skill --output astrolabe-skill.md
```

The skill file lists supported languages, MCP tools, and usage examples — designed to be ingested by LLM-based tool dispatchers.

## Commands

```bash
astrolabe analyze <repo>      Build the knowledge graph
astrolabe query <search>      Search for symbols
astrolabe context <symbol>    Show symbol definition context
astrolabe impact <symbol>     Show upstream/downstream impact
astrolabe list                List all symbols in the graph
astrolabe status              Show analysis status
astrolabe serve-mcp           Start MCP server for AI integration
astrolabe generate-skill      Generate AI assistant skill file
astrolabe clean               Remove analysis artifacts
astrolabe version             Show version
```

## Supported Languages

TypeScript, JavaScript, TSX, Python, Java, Go, Rust, C#, PHP, Ruby, Swift, C, C++, Dart, Kotlin

## Contributing

We use **GitHub Issues** to track bugs, features, and improvements — no PRs without an issue first.

### Workflow

1. **Find or create an issue** — bugs get the `bug` label, features get `enhancement`
2. **Discuss the approach** in the issue before coding
3. **Branch** from `main`: `git checkout -b fix/issue-123-description`
4. **Write real code changes** — every fix must have a corresponding diff
5. **Run tests**: `npm test` (142 passing required)
6. **Commit** with descriptive message: `fix: resolve <issue-title> (#N)`
7. **Push** and reference the issue: `Fixes #N`
8. **A reviewer agent** will inspect your changes and may file follow-up issues

### Commit Style

- Prefix with `fix:`, `feat:`, `refactor:`, `docs:`, `test:`, or `chore:`
- Reference the issue number in the body: `(#42)`
- Keep commits atomic — one logical change per commit

### Getting Help

- [Open an issue](https://github.com/danielperezr88/astrolabe/issues/new) for bugs, questions, or feature requests
- Tag `@danielperezr88` for maintainer attention

## License

MIT
