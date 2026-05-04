#!/usr/bin/env node
/**
 * @astrolabe/cli — CLI entry point with full command suite.
 */
import { program } from 'commander';
import { readFileSync, existsSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  createKnowledgeGraph, scanPhase, structurePhase, frameworkPhase, markdownPhase, parseEmitPhase,
  resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase,
  mroPhase, communityPhase, processTracingPhase,
  cobolPhase,
  callResolutionPhase, scopeResolutionPhase,
  initParser, createSqliteStore, createFtsSearch,
  createLogger, createPhaseContext, runPipeline, startMcpServer,
  loadRegistry, saveRegistry, removeRepo, getGitRemote,
  generateSkill,
  loadMeta, saveMeta, computeFileDiff, buildMeta,
  installHooks,
  createGroup, removeGroup, addRepoToGroup, removeRepoFromGroup, listGroups, getGroupStatus,
  autoSetup,
  generateAgentFiles,
  startHttpServer,
  generateWiki,
  startEvalServer,
} from '@astrolabe/core';
import type { ScanOutput } from '@astrolabe/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

function getGitCommit(repoPath: string): string {
  try { return execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim(); }
  catch { return 'unknown'; }
}

program.name('astrolabe').description('Codebase knowledge graph analysis tool').version(pkg.version);

program.command('version').description('Show version information').action(() => { console.log(`astrolabe v${pkg.version}`); });

// ── analyze ──────────────────────────────────────────────────────────────────
program
  .command('analyze <repoPath>')
  .description('Analyze a codebase and build the knowledge graph')
  .option('-o, --output <path>', 'Output database path', '.astrolabe/astrolabe.db')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .option('--skip-workers', 'Disable parallel parsing (sequential only)')
  .option('--skip-agents-md', 'Skip AGENTS.md/CLAUDE.md generation (#268)')
  .option('--skills', 'Generate per-community SKILL.md files (#267)')
  .option('--max-file-size <kb>', 'Skip files larger than N KB (default: 512, max: 32768)', parseInt)
  .action(async (repoPath: string, opts: { output: string; logLevel: string; skipWorkers?: boolean; skipAgentsMd?: boolean; skills?: boolean; maxFileSize?: number }) => {
    const log = createLogger({ level: opts.logLevel as any });
    log.info('Starting analysis', { repoPath, output: opts.output });

    // #373: Configure max file size (env var + CLI flag)
    if (opts.maxFileSize) {
      process.env.ASTROLABE_MAX_FILE_SIZE = String(Math.max(1, opts.maxFileSize));
      log.info(`ASTROLABE_MAX_FILE_SIZE: effective threshold ${process.env.ASTROLABE_MAX_FILE_SIZE}KB (default 512KB)`);
    }

    try {
      await initParser();
      const outDir = dirname(opts.output);
      if (outDir !== '.' && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      const dbPath = resolve(opts.output);
      const repoName = basename(repoPath);
      const lastCommit = getGitCommit(repoPath);
      const onProgress = () => undefined;

      // Phase 1: Always scan first — needed for meta.json and incremental diff
      const scanGraph = createKnowledgeGraph();
      const scanCtx = createPhaseContext(repoPath, scanGraph, onProgress);
      await runPipeline([scanPhase], scanCtx);
      const scanOutput = (scanCtx.state.get('output:scan') as ScanOutput | undefined);
      if (!scanOutput) throw new Error('Scan phase did not produce output');
      const currentHashes = new Map<string, string>();
      for (const f of scanOutput.files) currentHashes.set(f.path, f.hash);

      // #280: Attempt incremental analysis if previous analysis exists
      const storedMeta = loadMeta(dirname(dbPath));
      const dbExists = existsSync(dbPath);
      let graph: ReturnType<typeof createKnowledgeGraph>;
      let nodeCount = 0;
      let edgeCount = 0;
      let isIncremental = false; // #338: track for AGENTS.md generation

      if (storedMeta && dbExists) {
        // ── Incremental mode ──
        isIncremental = true; // #338: track for AGENTS.md generation
        log.info('Incremental analysis enabled — comparing file hashes...');
        const diff = computeFileDiff(currentHashes, storedMeta);
        const totalChanged = diff.changed.length + diff.added.length + diff.deleted.length;
        log.info('Incremental diff', {
          changed: diff.changed.length, added: diff.added.length,
          deleted: diff.deleted.length, unchanged: diff.unchanged.length,
        });

        // If nothing changed, skip analysis entirely but still save meta
        if (totalChanged === 0 && lastCommit === storedMeta.lastCommit) {
          log.info('No changes detected — analysis skipped.');
          saveMeta(dirname(dbPath), buildMeta(currentHashes, lastCommit));
          return;
        }

        // Load existing graph from DB, patch for deleted/changed files
        const loadStore = createSqliteStore(dbPath);
        graph = loadStore.loadGraph();
        loadStore.close();

        for (const fp of diff.deleted) graph.removeNodesByFile(fp);
        for (const fp of diff.changed) graph.removeNodesByFile(fp);

        // #318: Clean stale Community/Process nodes before re-running global phases
        // These phases operate on the entire graph and re-create output each run.
        for (const node of [...graph.iterNodes()]) {
          if (node.label === 'Community' || node.label === 'Process') {
            graph.removeNode(node.id);
          }
        }

        // Run remaining phases with file filter
        const ctx = createPhaseContext(repoPath, graph, onProgress);
        ctx.state.set('output:scan', scanOutput);
        ctx.state.set('skipWorkers', opts.skipWorkers ?? false);
        ctx.state.set('incremental:changedPaths', new Set([...diff.changed, ...diff.added]));
        await runPipeline([
          structurePhase, frameworkPhase, markdownPhase, parseEmitPhase,
          resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase,
          mroPhase, communityPhase, processTracingPhase,
          cobolPhase,
          callResolutionPhase, scopeResolutionPhase,
        ], ctx);

        nodeCount = graph.nodeCount;
        edgeCount = graph.relationshipCount;
        log.info('Incremental analysis complete', { nodes: nodeCount, edges: edgeCount });
      } else {
        // ── Full analysis (first run or missing meta/DB) ──
        graph = createKnowledgeGraph();
        const context = createPhaseContext(repoPath, graph, onProgress);
        context.state.set('output:scan', scanOutput);
        await runPipeline([
          structurePhase, frameworkPhase, markdownPhase, parseEmitPhase,
          resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase,
          mroPhase, communityPhase, processTracingPhase,
          cobolPhase,
          callResolutionPhase, scopeResolutionPhase,
        ], context);
        nodeCount = graph.nodeCount;
        edgeCount = graph.relationshipCount;
        log.info('Full analysis complete', { nodes: nodeCount, edges: edgeCount });
      }

      // Save graph to SQLite
      const store = createSqliteStore(dbPath);
      store.saveGraph(graph);
      // FTS index is created lazily on first query — no eager creation here
      store.close();

      // Save meta.json with current file hashes for next incremental run
      saveMeta(dirname(dbPath), buildMeta(currentHashes, lastCommit));

      // Register repo in global registry for multi-repo MCP support
      const repos = loadRegistry();
      const existingIdx = repos.findIndex((r) => r.path === repoPath);
      const remoteUrl = getGitRemote(repoPath) ?? undefined;
      const entry = { name: repoName, path: repoPath, dbPath, lastCommit, indexedAt: Date.now(), remoteUrl };
      if (existingIdx >= 0) repos[existingIdx] = entry; else repos.push(entry);
      saveRegistry(repos);

      // #276: Install Claude Code hooks for auto-augmentation
      const hookResult = installHooks(repoPath);
      log.info('Claude Code hooks installed', { scripts: hookResult.scripts, config: hookResult.config });

      // #268, #267: Generate AGENTS.md/CLAUDE.md and per-community skills
      if (!opts.skipAgentsMd) {
        // Count nodes by label
        const lc: Record<string, number> = {};
        for (const n of graph.iterNodes()) lc[n.label] = (lc[n.label] ?? 0) + 1;

        const agentResult = generateAgentFiles(repoPath, {
          repoName,
          repoPath,
          nodeCount,
          relationshipCount: edgeCount,
          processCount: lc['Process'] ?? 0,
          communityCount: lc['Community'] ?? 0,
          routeCount: lc['Route'] ?? 0,
          toolCount: lc['Tool'] ?? 0,
          lastCommit,
          isIncremental,
          graph: opts.skills ? graph : undefined,
          skills: opts.skills ?? false,
        });
        log.info('Agent files generated', { agentsMd: agentResult.agentsMd, claudeMd: agentResult.claudeMd, skillsCount: agentResult.skillsCount });
      }

      log.info('Analysis complete', { nodes: nodeCount, edges: edgeCount, repo: repoName });
    } catch (err) {
      log.error('Analysis failed', { error: String(err) });
      process.exit(1);
    }
  });

// ── query ────────────────────────────────────────────────────────────────────
program
  .command('query <search>')
  .description('Search the knowledge graph for symbols')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .option('-n, --limit <number>', 'Max results', '20')
  .action((search: string, opts: { db: string; limit: string }) => {
    const fts = createFtsSearch(opts.db);
    try {
      const results = fts.search(search, parseInt(opts.limit, 10) || 20);
      for (const r of results) console.log(`${r.label.padEnd(12)} ${r.name.padEnd(30)} ${r.filePath}`);
      if (results.length === 0) console.log('No results found.');
    } finally { fts.close(); }
  });

// ── serve-mcp ────────────────────────────────────────────────────────────────
program
  .command('serve-mcp')
  .description('Start an MCP server for AI assistant integration')
  .action(async () => { console.error('Astrolabe MCP server starting...'); await startMcpServer(); });

// ── serve (HTTP API) ──────────────────────────────────────────────────────
program
  .command('serve')
  .description('Start an HTTP API server for web UI and headless integration (#262)')
  .option('-p, --port <number>', 'Port to listen on', '4747')
  .option('-h, --host <host>', 'Host to bind to', 'localhost')
  .action((opts: { port: string; host: string }) => {
    const server = startHttpServer({ port: parseInt(opts.port, 10), host: opts.host });
    process.on('SIGINT', () => { server.close(); process.exit(0); });
    process.on('SIGTERM', () => { server.close(); process.exit(0); });
  });

// ── eval-server (REST eval API) ──────────────────────────────────────────
program
  .command('eval-server')
  .description('Start an eval REST server for benchmarking (#448)')
  .option('-p, --port <number>', 'Port to listen on', '4748')
  .option('-h, --host <host>', 'Host to bind to', 'localhost')
  .option('--idle-timeout <seconds>', 'Idle shutdown timeout in seconds', '300')
  .action((opts: { port: string; host: string; idleTimeout: string }) => {
    const server = startEvalServer({
      port: parseInt(opts.port, 10),
      host: opts.host,
      idleTimeout: parseInt(opts.idleTimeout, 10),
    });
    process.on('SIGINT', () => { server.close(); process.exit(0); });
    process.on('SIGTERM', () => { server.close(); process.exit(0); });
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show analysis status for the current repository')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .action((opts: { db: string }) => {
    if (!existsSync(opts.db)) { console.log('No analysis found. Run `astrolabe analyze <repo>` first.'); return; }
    const s = statSync(opts.db);
    console.log(`Database: ${opts.db}\nSize: ${(s.size / 1024).toFixed(1)} KB\nLast modified: ${s.mtime.toISOString()}`);
    try {
      const store = createSqliteStore(opts.db);
      try { console.log(`Nodes: ${store.getNodeCount()}\nRelationships: ${store.getRelationshipCount()}`); }
      finally { store.close(); }
    } catch { console.log('Unable to read database.'); }
  });

// ── clean ──────────────────────────────────────────────────────────────────────
program
  .command('clean')
  .description('Remove analysis artifacts (.astrolabe directory)')
  .action(() => {
    if (existsSync('.astrolabe')) { rmSync('.astrolabe', { recursive: true, force: true }); console.log('Removed .astrolabe directory.'); }
    else { console.log('No .astrolabe directory found.'); }
  });

// ── remove ────────────────────────────────────────────────────────────────────
program
  .command('remove <target>')
  .description('Unregister a repo from the global registry by name or path')
  .option('--purge', 'Also remove the .astrolabe directory from the repo')
  .option('--force', 'Skip confirmation prompt')
  .action(async (target: string, opts: { purge?: boolean; force?: boolean }) => {
    // Find matching entry without modifying the registry
    const repos = loadRegistry();
    const normalized = target.replace(/[/\\]+$/, '');
    const absTarget = resolve(normalized);
    const match = repos.find(
      (e) => e.name === normalized || e.path === normalized || e.path === absTarget,
    );
    if (!match) {
      console.log(`No registered repo matching "${target}" found.`);
      return;
    }

    console.log(`Found: ${match.name} (${match.path})`);

    // Confirmation prompt (skip with --force)
    if (!opts.force) {
      const answer = await new Promise<string>((res) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question('Remove from registry? [y/N] ', (ans) => { rl.close(); res(ans.trim().toLowerCase()); });
      });
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Cancelled.');
        return;
      }
    }

    const removed = removeRepo(target);
    if (removed) {
      console.log(`Removed "${removed.name}" from registry.`);
    }

    if (opts.purge && removed) {
      const astrolabeDir = join(removed.path, '.astrolabe');
      if (existsSync(astrolabeDir)) {
        rmSync(astrolabeDir, { recursive: true, force: true });
        console.log(`Purged .astrolabe directory at ${astrolabeDir}.`);
      } else {
        console.log(`No .astrolabe directory found at ${removed.path}.`);
      }
    }
  });

// ── context ────────────────────────────────────────────────────────────────────
program
  .command('context <symbol-name>')
  .description('Show the definition context for a symbol')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .action((symbolName: string, opts: { db: string }) => {
    const fts = createFtsSearch(opts.db);
    try {
      const results = fts.search(symbolName, 5);
      if (results.length === 0) { console.log(`No symbols found matching "${symbolName}".`); }
      else { console.log(`Context for "${symbolName}":`); for (const r of results) console.log(`  ${r.label} ${r.name}  (${r.filePath})`); }
    } finally { fts.close(); }
  });

// ── impact ─────────────────────────────────────────────────────────────────────
program
  .command('impact <symbol-name>')
  .description('Show code impact analysis for a symbol')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .action((symbolName: string, opts: { db: string }) => {
    const store = createSqliteStore(opts.db);
    try {
      const graph = store.loadGraph();

      // #134: Pre-build adjacency index (O(R)) for O(1) neighbor lookup
      const adj = new Map<string, Array<{ neighborId: string; type: string; direction: string }>>();
      for (const rel of graph.iterRelationships()) {
        let bucket = adj.get(rel.sourceId);
        if (!bucket) { bucket = []; adj.set(rel.sourceId, bucket); }
        bucket.push({ neighborId: rel.targetId, type: rel.type, direction: 'outgoing' });
        bucket = adj.get(rel.targetId);
        if (!bucket) { bucket = []; adj.set(rel.targetId, bucket); }
        bucket.push({ neighborId: rel.sourceId, type: rel.type, direction: 'incoming' });
      }

      let found = 0;
      for (const node of graph.iterNodes()) {
        if (node.properties.name === symbolName) {
          found++;
          console.log(`${node.label}: ${node.id}`);
          const neighbors = adj.get(node.id) ?? [];
          for (const { neighborId, type, direction } of neighbors) {
            const other = graph.getNode(neighborId);
            console.log(`  ${direction === 'outgoing' ? '→' : '←'} ${type} ${other?.properties.name ?? neighborId}`);
          }
        }
      }
      if (found === 0) console.log(`Symbol "${symbolName}" not found.`);
    } finally { store.close(); }
  });

// ── list ───────────────────────────────────────────────────────────────────────
program
  .command('list')
  .description('List all symbols in the knowledge graph')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .option('--label <label>', 'Filter by node label (Function, Class, etc.)')
  .action((opts: { db: string; label?: string }) => {
    const store = createSqliteStore(opts.db);
    try {
      const graph = store.loadGraph();
      let count = 0;
      for (const node of graph.iterNodes()) {
        if (opts.label && node.label !== opts.label) continue;
        count++;
        console.log(`${node.label.padEnd(12)} ${node.properties.name ?? '?'}  (${node.properties.filePath ?? '?'})`);
        if (count >= 100) { console.log('...(truncated at 100)'); break; }
      }
      if (count === 0) console.log('No symbols found.');
    } finally { store.close(); }
  });

// ── generate-skill ──────────────────────────────────────────────────────────────
program
  .command('generate-skill')
  .description('Generate a Markdown skill file for AI assistants (#110)')
  .option('-o, --output <path>', 'Output file path', 'astrolabe-skill.md')
  .action((opts: { output: string }) => {
    generateSkill(opts.output);
  });

// ── group (cross-repo management) ──────────────────────────────────────────
const groupCmd = program.command('group').description('Manage cross-repo groups for multi-repo tracking (#266)');

groupCmd.command('create <name>')
  .description('Create a new repository group')
  .action((name: string) => {
    const group = createGroup(name);
    console.log(`Group "${group.name}" created.`);
  });

groupCmd.command('remove <name>')
  .description('Remove a repository group')
  .action((name: string) => {
    removeGroup(name);
    console.log(`Group "${name}" removed.`);
  });

groupCmd.command('add <group> <path> <repoName>')
  .description('Add a repository to a group at the given hierarchy path')
  .action((group: string, path: string, repoName: string) => {
    addRepoToGroup(group, path, repoName);
    console.log(`Added "${repoName}" to group "${group}" at path "${path}".`);
  });

groupCmd.command('remove-repo <group> <path>')
  .description('Remove a repository from a group by hierarchy path')
  .action((group: string, path: string) => {
    removeRepoFromGroup(group, path);
    console.log(`Removed "${path}" from group "${group}".`);
  });

groupCmd.command('list')
  .description('List all groups')
  .action(() => {
    const groups = listGroups();
    if (groups.length === 0) {
      console.log('No groups defined. Use `astrolabe group create <name>` to create one.');
      return;
    }
    for (const g of groups) {
      console.log(`${g.name} (${Object.keys(g.repos).length} repos, created ${new Date(g.createdAt).toISOString()})`);
      for (const [path, repo] of Object.entries(g.repos)) {
        console.log(`  ${path} → ${repo.repoName}`);
      }
    }
  });

groupCmd.command('status <name>')
  .description('Show staleness and status of all repos in a group')
  .action((name: string) => {
    const status = getGroupStatus(name);
    console.log(`Group: ${status.name} (${status.repoCount} repos)`);
    for (const r of status.repos) {
      const staleIcon = r.stale ? '⚠' : '✓';
      const indexed = r.indexedAt ? new Date(r.indexedAt).toISOString() : 'never';
      console.log(`  ${staleIcon} ${r.path} → ${r.repoName} (indexed: ${indexed})`);
    }
  });

// ── setup (auto-detect editors and configure MCP) ─────────────────────────
program.command('setup')
  .description('Auto-detect editors (Cursor, Windsurf, Claude Code, etc.) and write MCP config')
  .option('--force', 'Overwrite existing configurations')
  .action((opts: { force?: boolean }) => {
    const results = autoSetup(opts.force ?? false);
    let configured = 0;

    for (const r of results) {
      if (r.configured) {
        console.log(`  ✓ ${r.editor} — ${r.path}`);
        configured++;
      } else if (r.skipped) {
        console.log(`  - ${r.editor}: ${r.skipped}`);
      } else if (r.error) {
        console.log(`  ✗ ${r.editor}: ${r.error}`);
      }
    }

    if (configured === 0 && results.every((r) => !r.configured && !r.skipped)) {
      console.log('\nNo supported editors detected. Manually configure MCP:');
      console.log('  https://github.com/danielperezr88/astrolabe#mcp-integration');
    } else {
      console.log(`\n${configured} editor(s) configured. Restart your editor to activate Astrolabe MCP.`);
    }
  });

// ── augment ───────────────────────────────────────────────────────────────────
interface AugmentRelated {
  name: string;
  label: string;
  filePath: string;
  relationship: string;
  direction: 'incoming' | 'outgoing';
  depth: number;
}

function augmentTraverse(
  graph: ReturnType<typeof createKnowledgeGraph>,
  startIds: Set<string>,
  maxDepth: number,
): AugmentRelated[] {
  // Build bidirectional adjacency index
  const adj = new Map<string, Array<{ neighborId: string; type: string; direction: 'incoming' | 'outgoing' }>>();
  for (const rel of graph.iterRelationships()) {
    let bucket = adj.get(rel.sourceId);
    if (!bucket) { bucket = []; adj.set(rel.sourceId, bucket); }
    bucket.push({ neighborId: rel.targetId, type: rel.type, direction: 'outgoing' });
    bucket = adj.get(rel.targetId);
    if (!bucket) { bucket = []; adj.set(rel.targetId, bucket); }
    bucket.push({ neighborId: rel.sourceId, type: rel.type, direction: 'incoming' });
  }

  // Relationship types we care about for augmentation
  const augTypes = new Set(['CALLS', 'IMPORTS', 'MEMBER_OF']);

  const visited = new Set<string>(startIds);
  const results: AugmentRelated[] = [];
  let frontier = new Set<string>(startIds);

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier = new Set<string>();
    for (const nodeId of frontier) {
      const neighbors = adj.get(nodeId) ?? [];
      for (const { neighborId, type, direction } of neighbors) {
        if (!augTypes.has(type)) continue;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        const neighbor = graph.getNode(neighborId);
        results.push({
          name: neighbor?.properties.name ?? neighborId,
          label: neighbor?.label ?? 'Unknown',
          filePath: neighbor?.properties.filePath ?? '',
          relationship: type,
          direction,
          depth,
        });
        nextFrontier.add(neighborId);
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  return results;
}

program
  .command('augment <pattern>')
  .description('Enrich a search pattern with graph context (callers, callees, imports, community members)')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .option('--depth <number>', 'Traversal depth (hops)', '2')
  .option('--format <format>', 'Output format: text or json', 'text')
  .action((pattern: string, opts: { db: string; depth: string; format: string }) => {
    if (!existsSync(opts.db)) {
      console.log('No analysis found. Run `astrolabe analyze <repo>` first.');
      return;
    }

    const depth = Math.max(1, parseInt(opts.depth, 10) || 2);
    const format = opts.format === 'json' ? 'json' : 'text';

    const store = createSqliteStore(opts.db);
    try {
      const graph = store.loadGraph();

      // Find nodes matching pattern (case-insensitive substring)
      const lowerPattern = pattern.toLowerCase();
      const matches: Array<{ id: string; name: string; label: string; filePath: string; startLine: number }> = [];
      for (const node of graph.iterNodes()) {
        const name = (node.properties.name as string) ?? '';
        if (name.toLowerCase().includes(lowerPattern)) {
          matches.push({
            id: node.id,
            name,
            label: node.label,
            filePath: (node.properties.filePath as string) ?? '',
            startLine: (node.properties.startLine as number) ?? 0,
          });
        }
      }

      if (matches.length === 0) {
        console.log(`No symbols found matching "${pattern}".`);
        return;
      }

      // Traverse from matched nodes
      const startIds = new Set(matches.map((m) => m.id));
      const related = augmentTraverse(graph, startIds, depth);

      if (format === 'json') {
        const output = {
          pattern,
          matches: matches.map((m) => ({
            id: m.id,
            name: m.name,
            label: m.label,
            filePath: m.filePath,
            startLine: m.startLine,
          })),
          related: related.map((r) => ({
            name: r.name,
            label: r.label,
            filePath: r.filePath,
            relationship: r.relationship,
            direction: r.direction,
            depth: r.depth,
          })),
        };
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(`Pattern: ${pattern}`);
        for (const m of matches) {
          console.log(`  Match: ${m.label}:${m.name} (${m.filePath}${m.startLine ? ':' + m.startLine : ''})`);
        }
        console.log(`Related (depth ${depth}):`);
        if (related.length === 0) {
          console.log('  (none)');
        } else {
          for (const r of related) {
            const dirLabel = r.direction === 'outgoing' ? 'callee' : 'caller';
            const relLabel = r.relationship === 'MEMBER_OF' ? 'same community' : dirLabel;
            const loc = r.filePath ? ` (${r.filePath})` : '';
            console.log(`  - ${r.name} (${relLabel}, depth ${r.depth})${loc}`);
          }
        }
      }
    } finally { store.close(); }
  });

// ── wiki (LLM-powered documentation generation) ────────────────────────────
program.command('wiki <repoPath>')
  .description('Generate LLM-powered wiki documentation from knowledge graph (#269)')
  .option('--model <model>', 'LLM model name', 'gpt-4o-mini')
  .option('--base-url <url>', 'LLM API base URL')
  .option('--force', 'Force full regeneration of wiki')
  .action(async (repoPath: string, opts: { model?: string; baseUrl?: string; force?: boolean }) => {
    const repoName = repoPath.split('/').pop() || repoPath;
    const dbPath = join(repoPath, '.astrolabe', 'astrolabe.db');

    if (!existsSync(dbPath)) {
      console.log('No knowledge graph found. Run `astrolabe analyze` first.');
      return;
    }

    const store = createSqliteStore(dbPath);
    const graph = store.loadGraph();
    store.close();

    console.log(`Generating wiki for ${repoName}...`);
    const result = await generateWiki({
      repoPath, repoName, graph,
      model: opts.model, baseUrl: opts.baseUrl, force: opts.force,
    });

    console.log(`Wiki generated: ${result.pageCount} pages, ${result.moduleCount} modules`);
    console.log(`Overview: ${result.overviewPath}`);
  });

program.parse();
