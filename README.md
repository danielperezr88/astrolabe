# Astrolabe

**Codebase knowledge graph engine** — multi-language static analysis with graph persistence, community detection, hybrid search, and AI integration.

Astrolabe builds a rich knowledge graph of your codebase by parsing 15+ languages via tree-sitter. It understands function calls, class hierarchies, imports, routes, ORM models, and structural relationships, then persists everything to SQLite for fast querying.

```bash
# Quick start with Docker
docker run -p 4747:4747 -v $(pwd):/workspace ghcr.io/danielperezr88/astrolabe

# Or install the CLI
npm install -g @astrolabe-dev/cli
astrolabe analyze .
astrolabe query "authenticate"
```

## Packages

| Package | Description |
|---------|-------------|
| [`@astrolabe-dev/core`](./packages/core) | Knowledge graph engine — parsing, phases, persistence, MCP server, HTTP API |
| [`@astrolabe-dev/cli`](./packages/cli) | Command-line interface (`astrolabe` command) |
| [`@astrolabe-dev/shared`](./packages/shared) | Type definitions and cross-platform utilities |
| [`astrolabe-vscode`](./packages/vscode) | VS Code extension — interactive graph exploration |

## Installation

### Docker (recommended for servers)

```bash
docker pull ghcr.io/danielperezr88/astrolabe
docker run -p 4747:4747 -v $(pwd):/workspace ghcr.io/danielperezr88/astrolabe
```

### Verify image signatures

Astrolabe Docker images are signed with [Cosign](https://github.com/sigstore/cosign) (keyless, via GitHub OIDC) and include SPDX SBOM attestations.

```bash
# Install Cosign (if not already installed)
# macOS: brew install cosign
# Linux: go install github.com/sigstore/cosign/v2/cmd/cosign@latest

COSIGN_EXPERIMENTAL=1 cosign verify \
  --certificate-identity "https://github.com/danielperezr88/astrolabe/.github/workflows/release.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/danielperezr88/astrolabe:latest

# Verify SBOM attestation
COSIGN_EXPERIMENTAL=1 cosign verify-attestation --type spdxjson \
  --certificate-identity "https://github.com/danielperezr88/astrolabe/.github/workflows/release.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/danielperezr88/astrolabe:latest
```

### CLI (npm)

```bash
npm install -g @astrolabe-dev/cli
astrolabe analyze /path/to/repo
```

### Build from Source

```bash
git clone https://github.com/danielperezr88/astrolabe.git
cd astrolabe
npm install
npm run build        # Builds shared → core → cli → vscode
npm link             # Makes `astrolabe` available globally
```

**Running tests:**

```bash
npm test             # 472 pass, 12 skipped (WASM/grammar)
```

### VS Code Extension

For development, install the extension as a symlink:

```bash
npm run build
# Windows (PowerShell as Administrator):
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.vscode\extensions\astrolabe-vscode" -Target (Resolve-Path packages/vscode)
# macOS / Linux:
ln -s $(pwd)/packages/vscode ~/.vscode/extensions/astrolabe-vscode
```

Alternatively, open `packages/vscode` in VS Code and press F5 (Extension Development Host).

## Commands

### Analysis & Querying

| Command | Description |
|---------|-------------|
| `astrolabe analyze <repo>` | Build the knowledge graph from a repository |
| `astrolabe query <search>` | Hybrid search for symbols |
| `astrolabe context <symbol>` | 360° symbol view — incoming/outgoing edges, processes |
| `astrolabe impact <symbol>` | Blast radius analysis — upstream/downstream impact |
| `astrolabe augment <pattern>` | Enrich search results with graph context |
| `astrolabe list` | List all symbols in the graph (`--label` to filter) |

`analyze` flags: `--output`, `--log-level`, `--skip-workers`, `--skip-agents-md`, `--skills`, `--max-file-size`, `--profile`

> **Concurrency note**: Running `astrolabe analyze` while the MCP server (`serve-mcp`) is active on the same repo will be blocked to prevent SQLite WAL corruption. Stop the MCP server first, or analyze a different repository.

### Server & Integration

| Command | Description |
|---------|-------------|
| `astrolabe serve` | Start HTTP API server (`--port`, `--host`) |
| `astrolabe serve-mcp` | Start MCP server for AI assistant integration |
| `astrolabe eval-server` | Start REST eval server for benchmarking (`--port`, `--host`, `--idle-timeout`) |

### Repository Management

| Command | Description |
|---------|-------------|
| `astrolabe status` | Show analysis status |
| `astrolabe remove <target>` | Unregister a repo (`--purge`, `--force`) |
| `astrolabe clean` | Remove analysis artifacts |
| `astrolabe setup` | Auto-detect editors and configure MCP (`--force`) |

### Cross-Repo Groups

| Command | Description |
|---------|-------------|
| `astrolabe group create <name>` | Create a new group |
| `astrolabe group remove <name>` | Remove a group |
| `astrolabe group add <group> <path> <repo>` | Add repo to group |
| `astrolabe group remove-repo <group> <path>` | Remove repo from group |
| `astrolabe group list` | List all groups |
| `astrolabe group status <name>` | Show group staleness |

### Documentation & Utilities

| Command | Description |
|---------|-------------|
| `astrolabe wiki <repo>` | LLM-powered wiki generation (`--model`, `--review`, `--resume`, `--gist`) |
| `astrolabe generate-skill` | Generate AI assistant skill file (`--output`) |
| `astrolabe version` | Show version |

## HTTP REST API

The `serve` command exposes a REST API on port 4747:

### Repository & Query

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check with repo list |
| `GET` | `/api/repos` | List all indexed repos |
| `GET` | `/api/repo/:name/context` | Repo overview — node counts, cluster summary |
| `GET` | `/api/repo/:name/clusters` | Community detection clusters |
| `GET` | `/api/repo/:name/graph` | Graph data for visualization (`?cluster=id` to filter) |
| `GET` | `/api/repo/:name/graph/stream` | NDJSON streaming graph export |
| `POST` | `/api/repo/:name/query` | Search the knowledge graph |
| `POST` | `/api/repo/:name/impact` | Symbol impact analysis |
| `GET` | `/api/repo/:name/grep` | Regex file search |

### Analysis Jobs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/analyze` | Start async analysis job |
| `GET` | `/api/analyze/:jobId` | Poll job status |
| `GET` | `/api/analyze/:jobId/progress` | SSE progress stream |
| `DELETE` | `/api/analyze/:jobId` | Cancel running job |

### AI

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/chat` | RAG conversational AI assistant |

## MCP Integration

Astrolabe provides a Model Context Protocol server for AI assistant integration (Claude, Cursor, etc.):

### Configuration

```json
{
  "mcpServers": {
    "astrolabe": {
      "command": "npx",
      "args": ["-y", "@astrolabe-dev/cli", "serve-mcp"]
    }
  }
}
```

Or point to your local build:

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

### Tools (22)

**Core Analysis**

| Tool | Description |
|------|-------------|
| `list_repos` | List all indexed repositories |
| `query` | Hybrid search with context boosting (`query`, `limit`, `repo`, `service`, `task_context`, `goal`) |
| `context` | 360° symbol view — incoming/outgoing edges (`name`, `repo`) |
| `impact` | Blast radius with cross-repo fan-out (`target`, `direction`, `maxDepth`, `minConfidence`, `crossDepth`) |
| `detect_changes` | Git-diff based symbol impact (`scope`: unstaged/staged/all) |
| `filter_by_label` | Filter graph nodes by label |
| `grep` | Regex search across indexed files |

**Refactoring & Graph Queries**

| Tool | Description |
|------|-------------|
| `rename` | Preview multi-file symbol rename (`dry_run` mode) |
| `cypher` | Graph traversal query engine (match/traverse/return) |
| `graph_algorithms` | PageRank, betweenness centrality, shortest path |

**Architecture**

| Tool | Description |
|------|-------------|
| `route_map` | Map routes → consumers |
| `tool_map` | Map tools → callers |
| `api_impact` | Pre-change route/tool impact analysis |
| `shape_check` | Detect API response shape mismatches |

**Cross-Repo Groups**

| Tool | Description |
|------|-------------|
| `group_list` | List all cross-repo groups |
| `group_status` | Check group staleness |
| `group_query` | Fan-out search across group repos |
| `group_sync` | Extract cross-repo HTTP contracts |
| `group_contracts` | Inspect extracted contracts |
| `group_impact` | Cross-repo impact via contract tracing |

**AI**

| Tool | Description |
|------|-------------|
| `chat` | RAG conversational AI assistant (`message`, `repo`, `history`) |

### Prompts (3)

| Prompt | Description |
|--------|-------------|
| `detect_impact` | Pre-commit change analysis workflow |
| `generate_map` | Architecture documentation generation |
| `refactor_safety` | Safe refactor analysis |

### Resources

| URI | Description |
|-----|-------------|
| `astrolabe://repos` | All indexed repositories |
| `astrolabe://setup` | AGENTS.md content for onboarding |
| `astrolabe://repo/{name}/context` | Repo overview |
| `astrolabe://repo/{name}/clusters` | Community clusters |
| `astrolabe://repo/{name}/processes` | Execution flows |
| `astrolabe://repo/{name}/schema` | Graph schema |
| `astrolabe://group/{name}/contracts` | Cross-repo contract registry |

## Wiki Generation

Generate LLM-powered documentation from the knowledge graph:

```bash
astrolabe wiki /path/to/repo                    # Generate wiki pages
astrolabe wiki /path/to/repo --review           # Stop for manual review of module tree
astrolabe wiki /path/to/repo --resume           # Continue from edited module tree
astrolabe wiki /path/to/repo --gist             # Publish to GitHub Gist
astrolabe wiki /path/to/repo --model gpt-4o     # Use specific LLM model
```

## Claude Code Hooks

Astrolabe auto-installs hooks during `analyze` that enrich Claude Code sessions:

- **Pre-tool-use hook** — Enriches tool results with graph context
- **Post-tool-use hook** — Detects stale indexes, suggests re-analysis

Hooks are written to `.claude/hooks/` and merged into existing `hooks.json`.

## Auto-Setup

Configure MCP integration for your editors with a single command:

```bash
astrolabe setup          # Auto-detect editors and write MCP configs
astrolabe setup --force  # Overwrite existing configs
```

Supports Cursor, Windsurf, Claude Code, and more.

## Skill Generation

Generate a Markdown skill file for AI assistants:

```bash
astrolabe generate-skill --output astrolabe-skill.md
```

## Supported Languages

TypeScript, JavaScript, TSX, Python, Java, Go, Rust, C#, PHP, Ruby, Swift, C, C++, Dart, Kotlin

## Contributing

We use **GitHub Issues** to track bugs, features, and improvements.

### Branching Model

```
feature/fix-xxx ──PR──▶ staging (auto RC) ──PR──▶ main (stable release)
```

**Rules:**
- Never push directly to `main` or `staging` — always use PRs
- All PRs require 1 approval and passing status checks
- Linear history enforced (rebase or squash-merge)

### Workflow

1. **Find or create an issue** — bugs get `bug`, features get `enhancement`
2. **Branch** from `staging`: `git checkout -b fix/issue-123-description origin/staging`
3. **Implement** the fix with real code changes
4. **Run tests**: `npm test` (472 passing required, 12 skipped OK)
5. **Commit**: `fix: resolve auth crash (#42)` — one logical change per commit
6. **Push and open PR** to `staging`
7. **Merge** after checks pass and approval
8. When staging is ready, open PR from `staging` → `main` for release

### Commit Style

- Prefix with `fix:`, `feat:`, `refactor:`, `docs:`, `test:`, or `chore:`
- Reference the issue number: `(#42)`
- Keep commits atomic — one logical change per commit

### CI/CD

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push/PR to `main` or `staging` | Unit + integration tests |
| `docker.yml` | PR to `main` or `staging` | Docker build validation |
| `rc.yml` | Push to `staging` | Auto RC version bump → Docker image → pre-release |
| `release.yml` | Push to `main` | Integration tests → stable Docker image → GitHub release |

### Getting Help

- [Open an issue](https://github.com/danielperezr88/astrolabe/issues/new) for bugs, questions, or feature requests
- Tag `@danielperezr88` for maintainer attention

## License

MIT
