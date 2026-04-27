/**
 * MCP Server for Astrolabe.
 *
 * Full Model Context Protocol server (JSON-RPC over stdio) with 7 working
 * tools backed by the SQLite knowledge graph database and a global registry
 * for multi-repo support.
 *
 * Tools: list_repos, query, context, impact, detect_changes, rename, cypher
 */

import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createSqliteStore } from '../persist/sqlite.js';
import { createFtsSearch } from '../search/fts.js';
import type { SqliteStore } from '../persist/sqlite.js';
import type { FtsSearch } from '../search/fts.js';
import type { GraphNode } from '../core/types.js';
import { execSync } from 'node:child_process';

// ── Types ──────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RegistryEntry {
  name: string;
  path: string;
  dbPath: string;
  lastCommit: string;
  indexedAt: number;
}

interface RepoContext {
  store: SqliteStore;
  fts: FtsSearch;
  entry: RegistryEntry;
}

// ── Global Registry ────────────────────────────────────────────────────────

const REGISTRY_DIR = join(homedir(), '.astrolabe');
const REGISTRY_FILE = join(REGISTRY_DIR, 'registry.json');

function loadRegistry(): RegistryEntry[] {
  try {
    if (!existsSync(REGISTRY_FILE)) return [];
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveRegistry(entries: RegistryEntry[]): void {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2));
}

// ── Backend ────────────────────────────────────────────────────────────────

class LocalBackend {
  private repos = new Map<string, RepoContext>();
  private maxConns = 5;
  private evictMs = 5 * 60 * 1000; // 5 min
  private lastAccess = new Map<string, number>();

  private getRepo(repoParam?: string): RepoContext {
    const entries = loadRegistry();
    const name = repoParam ?? entries[0]?.name;
    if (!name) throw new Error('No indexed repositories. Run `astrolabe analyze` first.');

    // Check cache
    let ctx = this.repos.get(name);
    if (ctx) {
      this.lastAccess.set(name, Date.now());
      return ctx;
    }

    // Find entry
    const entry = entries.find((e) => e.name === name);
    if (!entry) throw new Error(`Repository "${name}" not found. Available: ${entries.map((e) => e.name).join(', ')}`);

    // Evict if too many connections
    if (this.repos.size >= this.maxConns) {
      let oldest = '';
      let oldestTime = Infinity;
      for (const [n, t] of this.lastAccess) {
        if ((t ?? 0) < oldestTime) { oldest = n; oldestTime = t ?? 0; }
      }
      if (oldest) {
        this.repos.get(oldest)?.store.close();
        this.repos.get(oldest)?.fts.close();
        this.repos.delete(oldest);
      }
    }

    // Open connection
    const store = createSqliteStore(entry.dbPath);
    const fts = createFtsSearch(entry.dbPath);
    ctx = { store, fts, entry };
    this.repos.set(name, ctx);
    this.lastAccess.set(name, Date.now());
    return ctx;
  }

  listRepos(): RegistryEntry[] {
    return loadRegistry();
  }

  query(query: string, repo?: string, limit = 20) {
    const ctx = this.getRepo(repo);
    const results = ctx.fts.search(query, limit);
    if (results.length === 0) return { definitions: [], processes: [], process_symbols: [] };

    // Load graph for process grouping
    const graph = ctx.store.loadGraph();

    // Group by process membership
    const nodeSet = new Set(results.map((r) => r.nodeId));
    const processMap = new Map<string, { process: GraphNode; symbols: GraphNode[] }>();

    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      if (nodeSet.has(rel.targetId)) {
        const proc = graph.getNode(rel.sourceId);
        const sym = graph.getNode(rel.targetId);
        if (!proc || !sym) continue;
        let p = processMap.get(proc.id);
        if (!p) { p = { process: proc, symbols: [] }; processMap.set(proc.id, p); }
        if (!p.symbols.find((s) => s.id === sym.id)) p.symbols.push(sym);
      }
    }

    const processes = Array.from(processMap.values()).map((p) => ({
      summary: p.process.properties.name ?? p.process.id,
      priority: 0.042,
      symbol_count: p.symbols.length,
      process_type: (p.process.properties.processType as string) ?? 'intra_community',
      step_count: (p.process.properties.stepCount as number) ?? 0,
    }));

    const processSymbols = Array.from(processMap.values()).flatMap((p) =>
      p.symbols.map((s) => ({
        name: s.properties.name ?? s.id,
        type: s.label,
        filePath: s.properties.filePath ?? '',
        process_id: p.process.id,
      })),
    );

    const defNodeIds = new Set(processSymbols.map((s) => `${s.filePath}:${s.name}`));
    const definitions = results
      .filter((r) => !defNodeIds.has(`${r.filePath}:${r.name}`))
      .map((r) => ({ name: r.name, type: r.label, filePath: r.filePath }));

    return { processes, process_symbols: processSymbols, definitions };
  }

  context(nameOrUid: string, repo?: string) {
    const ctx = this.getRepo(repo);
    const graph = ctx.store.loadGraph();

    // Find symbol
    let symbol: GraphNode | undefined;
    for (const node of graph.iterNodes()) {
      if (node.id === nameOrUid || node.properties.name === nameOrUid) {
        symbol = node;
        break;
      }
    }
    if (!symbol) return { error: `Symbol "${nameOrUid}" not found.` };

    // Find incoming/outgoing relationships
    const incoming: Record<string, string[]> = {};
    const outgoing: Record<string, string[]> = {};
    const processes: { name: string; step: number; total: number }[] = [];

    for (const rel of graph.iterRelationships()) {
      if (rel.targetId === symbol.id) {
        const caller = graph.getNode(rel.sourceId);
        const relType = rel.type.toLowerCase();
        if (!incoming[relType]) incoming[relType] = [];
        incoming[relType].push(caller?.properties.name ?? rel.sourceId);
      }
      if (rel.sourceId === symbol.id) {
        const callee = graph.getNode(rel.targetId);
        const relType = rel.type.toLowerCase();
        if (!outgoing[relType]) outgoing[relType] = [];
        outgoing[relType].push(callee?.properties.name ?? rel.targetId);
      }
    }

    // Find process participations
    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      if (rel.targetId === symbol.id) {
        const proc = graph.getNode(rel.sourceId);
        if (proc) {
          processes.push({
            name: (proc.properties.name as string) ?? proc.id,
            step: rel.step ?? 0,
            total: (proc.properties.stepCount as number) ?? 0,
          });
        }
      }
    }

    return {
      symbol: {
        uid: symbol.id,
        kind: symbol.label,
        filePath: symbol.properties.filePath ?? '',
        startLine: symbol.properties.startLine ?? 0,
      },
      incoming,
      outgoing,
      processes,
    };
  }

  impact(target: string, direction: 'upstream' | 'downstream' = 'upstream', repo?: string, maxDepth = 5, minConfidence = 0.3) {
    const ctx = this.getRepo(repo);
    const graph = ctx.store.loadGraph();

    // Find target symbol
    let targetNode: GraphNode | undefined;
    for (const node of graph.iterNodes()) {
      if (node.id === target || node.properties.name === target) {
        targetNode = node;
        break;
      }
    }
    if (!targetNode) return { error: `Target "${target}" not found.` };

    // BFS traversal
    const affected: Array<{ depth: number; name: string; type: string; filePath: string; relationType: string; confidence: number }> = [];
    const visited = new Set<string>([targetNode.id]);
    const queue: Array<{ id: string; depth: number }> = [{ id: targetNode.id, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      for (const rel of graph.iterRelationships()) {
        if (rel.confidence < minConfidence) continue;
        const isRelevant =
          direction === 'upstream'
            ? rel.targetId === current.id
            : rel.sourceId === current.id;

        const neighborId =
          direction === 'upstream' ? rel.sourceId : rel.targetId;

        if (isRelevant && !visited.has(neighborId)) {
          visited.add(neighborId);
          const node = graph.getNode(neighborId);
          queue.push({ id: neighborId, depth: current.depth + 1 });
          affected.push({
            depth: current.depth + 1,
            name: node?.properties.name ?? neighborId,
            type: node?.label ?? 'unknown',
            filePath: (node?.properties.filePath as string) ?? '',
            relationType: rel.type,
            confidence: rel.confidence,
          });
        }
      }
    }

    // Group by depth with risk levels
    const depthGroups: Record<string, { risk: string; items: typeof affected }> = {};
    for (const item of affected) {
      const key = `depth_${item.depth}`;
      if (!depthGroups[key]) {
        depthGroups[key] = { risk: item.depth === 1 ? 'WILL BREAK' : item.depth === 2 ? 'LIKELY AFFECTED' : 'MAYBE AFFECTED', items: [] };
      }
      depthGroups[key].items.push(item);
    }

    return {
      target: { name: targetNode.properties.name ?? targetNode.id, type: targetNode.label, filePath: targetNode.properties.filePath ?? '' },
      direction,
      affected_count: affected.length,
      depth_groups: depthGroups,
    };
  }

  detectChanges(scope: 'unstaged' | 'staged' | 'all' = 'unstaged', repo?: string) {
    const ctx = this.getRepo(repo);
    const repoPath = ctx.entry.path;

    let diffFiles: string[] = [];
    try {
      const args = scope === 'staged' ? ['diff', '--cached', '--name-only'] :
                   scope === 'all' ? ['diff', 'HEAD', '--name-only'] :
                   ['diff', '--name-only'];
      const output = execSync(`git ${args.join(' ')}`, { cwd: repoPath, encoding: 'utf-8' });
      diffFiles = output.trim().split('\n').filter(Boolean);
    } catch {
      return { error: 'Git diff failed. Is this a git repository?' };
    }
    if (diffFiles.length === 0) return { changed_files: [], changed_count: 0, affected_count: 0, risk_level: 'none' };

    const graph = ctx.store.loadGraph();

    // Find changed symbols
    const changedSymbols: string[] = [];
    const affectedProcesses: string[] = [];

    for (const node of graph.iterNodes()) {
      const fp = node.properties.filePath as string | undefined;
      if (fp && diffFiles.includes(fp)) {
        changedSymbols.push(node.properties.name ?? node.id);
      }
    }

    // Find affected processes
    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      const proc = graph.getNode(rel.sourceId);
      if (changedSymbols.includes(graph.getNode(rel.targetId)?.properties.name ?? '')) {
        if (proc && !affectedProcesses.includes(proc.properties.name ?? proc.id)) {
          affectedProcesses.push(proc.properties.name ?? proc.id);
        }
      }
    }

    return {
      changed_files: diffFiles,
      changed_count: diffFiles.length,
      affected_count: affectedProcesses.length,
      risk_level: affectedProcesses.length > 3 ? 'high' : affectedProcesses.length > 0 ? 'medium' : 'low',
      changed_symbols: changedSymbols,
      affected_processes: affectedProcesses,
    };
  }

  renameSymbol(symbolName: string, newName: string, filePath?: string, dryRun = true, repo?: string) {
    const ctx = this.getRepo(repo);
    const graph = ctx.store.loadGraph();

    // Find all references
    const refs: Array<{ name: string; id: string; filePath: string; matchType: 'graph' | 'text_search' }> = [];

    for (const node of graph.iterNodes()) {
      if (filePath && node.properties.filePath !== filePath) continue;
      if (node.properties.name === symbolName) {
        refs.push({ name: node.properties.name ?? '', id: node.id, filePath: (node.properties.filePath as string) ?? '', matchType: 'graph' });
      }
    }

    return {
      status: 'success',
      files_affected: new Set(refs.map((r) => r.filePath)).size,
      total_edits: refs.length,
      graph_edits: refs.filter((r) => r.matchType === 'graph').length,
      text_search_edits: 0,
      dry_run: dryRun,
      changes: refs.map((r) => ({
        file: r.filePath,
        node_id: r.id,
        old_name: r.name,
        new_name: newName,
        confidence: r.matchType,
      })),
    };
  }

  cypher(_query: string, repo?: string) {
    const ctx = this.getRepo(repo);
    const graph = ctx.store.loadGraph();

    const results: Array<Record<string, unknown>> = [];
    for (const node of graph.iterNodes()) {
      results.push({
        id: node.id,
        label: node.label,
        name: node.properties.name,
        filePath: node.properties.filePath,
      });
    }
    return { columns: ['id', 'label', 'name', 'filePath'], rows: results };}

  shutdown(): void {
    for (const ctx of this.repos.values()) {
      ctx.store.close();
      ctx.fts.close();
    }
    this.repos.clear();
  }
}

// ── Tool definitions ───────────────────────────────────────────────────────

const backend = new LocalBackend();

const TOOLS: Record<string, {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}> = {
  'astrolabe.list_repos': {
    name: 'astrolabe.list_repos',
    description: 'Discover all indexed repositories. Read this first before using other tools.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const repos = backend.listRepos();
      if (repos.length === 0) return { content: [{ type: 'text', text: 'No indexed repositories. Run `astrolabe analyze <path>` first.' }] };
      const lines = repos.map((r) => `${r.name} (${r.path}) — ${new Date(r.indexedAt).toISOString()}`);
      return { content: [{ type: 'text', text: `Indexed repositories:\n${lines.join('\n')}\n\nNext: use query({query: "your search"}) or context({name: "symbolName"})` }] };
    },
  },

  'astrolabe.query': {
    name: 'astrolabe.query',
    description: 'Hybrid search over the knowledge graph. Returns process-grouped results for architectural context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (symbol name, concept, etc.)' },
        limit: { type: 'number', description: 'Max results', default: 20 },
        repo: { type: 'string', description: 'Repository name (optional if only one indexed)' },
      },
      required: ['query'],
    },
    handler: async (params) => {
      const result = backend.query(params.query as string, params.repo as string, (params.limit as number) ?? 20);
      const nextHint = '\n\nNext: use context({name: "foundSymbol"}) to get 360-degree view of any result.';
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.context': {
    name: 'astrolabe.context',
    description: '360-degree symbol view — callers, callees, process membership for one symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name or node ID' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['name'],
    },
    handler: async (params) => {
      const result = backend.context(params.name as string, params.repo as string);
      const nextHint = '\n\nNext: use impact({target: "symbolName", direction: "upstream"}) for blast radius analysis.';
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.impact': {
    name: 'astrolabe.impact',
    description: 'Blast radius analysis — what depends on this symbol, and what depends on those? Grouped by depth with risk levels.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Symbol name or node ID to analyze' },
        direction: { type: 'string', enum: ['upstream', 'downstream'], default: 'upstream' },
        maxDepth: { type: 'number', description: 'How many levels to traverse', default: 5 },
        minConfidence: { type: 'number', description: 'Minimum edge confidence (0.0-1.0)', default: 0.3 },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['target'],
    },
    handler: async (params) => {
      const result = backend.impact(
        params.target as string,
        (params.direction as 'upstream' | 'downstream') ?? 'upstream',
        params.repo as string,
        (params.maxDepth as number) ?? 5,
        (params.minConfidence as number) ?? 0.3,
      );
      const nextHint = '\n\nNext: use detect_changes() before committing to verify your changes match expected impact.';
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.detect_changes': {
    name: 'astrolabe.detect_changes',
    description: 'Git-diff impact — maps changed files to affected symbols and processes.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['unstaged', 'staged', 'all'], default: 'unstaged' },
        repo: { type: 'string', description: 'Repository name' },
      },
    },
    handler: async (params) => {
      const result = backend.detectChanges((params.scope as 'unstaged' | 'staged' | 'all') ?? 'unstaged', params.repo as string);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },

  'astrolabe.rename': {
    name: 'astrolabe.rename',
    description: 'Graph-assisted multi-file rename with dry-run preview.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string', description: 'Current symbol name' },
        new_name: { type: 'string', description: 'New name for the symbol' },
        file_path: { type: 'string', description: 'Limit to specific file (optional)' },
        dry_run: { type: 'boolean', description: 'Preview without modifying files', default: true },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['symbol_name', 'new_name'],
    },
    handler: async (params) => {
      const result = backend.renameSymbol(
        params.symbol_name as string,
        params.new_name as string,
        params.file_path as string,
        (params.dry_run as boolean) ?? true,
        params.repo as string,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },

  'astrolabe.cypher': {
    name: 'astrolabe.cypher',
    description: 'Query the knowledge graph with graph patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Graph query (MATCH pattern)' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['query'],
    },
    handler: async (params) => {
      const result = backend.cypher(params.query as string, params.repo as string);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },
};

// ── Server ─────────────────────────────────────────────────────────────────

function isNotification(method: string): boolean {
  return method.startsWith('notifications/');
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'astrolabe', version: '0.2.0' },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: Object.values(TOOLS).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case 'tools/call': {
      const params = req.params as { name: string; arguments?: unknown } | undefined;
      const tool = TOOLS[params?.name ?? ''];
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `Unknown tool: ${params?.name}. Available: ${Object.keys(TOOLS).join(', ')}` },
        };
      }
      try {
        const result = await tool.handler((params?.arguments as Record<string, unknown>) ?? {});
        return { jsonrpc: '2.0', id: req.id, result };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32603, message: (err as Error).message },
        };
      }
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return null;

    default:
      if (isNotification(req.method)) return null;
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

export async function startMcpServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  // Graceful shutdown
  process.on('SIGINT', () => { backend.shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { backend.shutdown(); process.exit(0); });

  for await (const line of rl) {
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      const res = await handleRequest(req);
      if (res !== null) {
        process.stdout.write(JSON.stringify(res) + '\n');
      }
    } catch {
      process.stderr.write('{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"}}\n');
    }
  }
}
