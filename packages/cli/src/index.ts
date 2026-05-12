#!/usr/bin/env node
/**
 * @astrolabe-dev/cli — CLI entry point with full command suite.
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
  accessTrackingPhase,
  securityScanPhase,
  coveragePhase,
  callResolutionPhase, scopeResolutionPhase,
  initParser, createSqliteStore, createFtsSearch,
  createLogger, createPhaseContext, runPipeline, startMcpServer,
  loadRegistry, saveRegistry, removeRepo, getGitRemote,
  acquireDbLock,
  generateSkill,
  loadMeta, saveMeta, computeFileDiff, buildMeta,
  installHooks,
  createGroup, removeGroup, addRepoToGroup, removeRepoFromGroup, listGroups, getGroupStatus,
  groupQuery, getGroupContracts, syncGroupContracts,
  autoSetup,
  generateAgentFiles,
  startHttpServer,
  generateWiki,
  startEvalServer,
  countGraphlets, buildAdjacencyMap, detectPatterns, scoreArchitectureHealth,
  migrateFromGitNexus,
  detectCutVertices, detectBridges,
} from '@astrolabe-dev/core';
// #463: Coverage report parser
import { parseCoverageReport, detectFormat, annotateGraphWithCoverage } from '@astrolabe-dev/core';
import type { ScanOutput, IncrementalInfo, PhaseTimerResult } from '@astrolabe-dev/core';
import { PIPELINE_TIMING_KEY, PIPELINE_MEMORY_KEY } from '@astrolabe-dev/core';
import { startWatch } from './watch.js';

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
  .option('--no-stats', 'Omit volatile counts from AGENTS.md/CLAUDE.md (#760)')
  .option('--max-file-size <kb>', 'Skip files larger than N KB (default: 512, max: 32768)', parseInt)
  .option('--profile', 'Emit phase-level timing information (Pitfall 7)')
  .action(async (repoPath: string, opts: { output: string; logLevel: string; skipWorkers?: boolean; skipAgentsMd?: boolean; skills?: boolean; noStats?: boolean; maxFileSize?: number; profile?: boolean }) => {
    const log = createLogger({ level: opts.logLevel as any });
    log.info('Starting analysis', { repoPath, output: opts.output });

    // #373: Configure max file size (env var + CLI flag)
    if (opts.maxFileSize) {
      process.env.ASTROLABE_MAX_FILE_SIZE = String(Math.max(1, opts.maxFileSize));
      log.info(`ASTROLABE_MAX_FILE_SIZE: effective threshold ${process.env.ASTROLABE_MAX_FILE_SIZE}KB (default 512KB)`);
    }

    let dbLock: ReturnType<typeof acquireDbLock> | null = null;
    try {
      await initParser();
      const outDir = dirname(opts.output);
      if (outDir !== '.' && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      const dbPath = resolve(opts.output);
      const repoName = basename(repoPath);

      // #643: Acquire advisory lock to prevent concurrent CLI + MCP writes
      dbLock = acquireDbLock(dirname(dbPath));
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

      // #732: Capture pipeline context for --profile / benchmark output
      let profileCtx: { state: Map<string, unknown> } | null = null;

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

        // #632: Build incremental info for phase-level skip decisions
        const incrementalInfo: IncrementalInfo = {
          changedPaths: new Set(diff.changed),
          addedPaths: new Set(diff.added),
          deletedPaths: new Set(diff.deleted),
          unchangedPaths: new Set(diff.unchanged),
          isIncremental: true,
        };

        // Run remaining phases with file filter
        const ctx = createPhaseContext(repoPath, graph, onProgress, incrementalInfo);
        ctx.state.set('output:scan', scanOutput);
        ctx.state.set('skipWorkers', opts.skipWorkers ?? false);
        ctx.state.set('profile', opts.profile ?? false);
        // Deprecated: kept for backward compat with phases still using changedPaths pattern
        ctx.state.set('incremental:changedPaths', new Set([...diff.changed, ...diff.added]));
        await runPipeline([
          structurePhase, frameworkPhase, markdownPhase, parseEmitPhase,
          resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase,
          mroPhase, communityPhase, processTracingPhase, accessTrackingPhase,
          coveragePhase,
          cobolPhase,
          callResolutionPhase, scopeResolutionPhase, securityScanPhase,
        ], ctx);

        nodeCount = graph.nodeCount;
        edgeCount = graph.relationshipCount;
        log.info('Incremental analysis complete', { nodes: nodeCount, edges: edgeCount });
        // #732: Capture pipeline context for --profile / benchmark output
        profileCtx = ctx;
      } else {
        // ── Full analysis (first run or missing meta/DB) ──
        graph = createKnowledgeGraph();
        const context = createPhaseContext(repoPath, graph, onProgress);
        context.state.set('output:scan', scanOutput);
        context.state.set('profile', opts.profile ?? false);
        await runPipeline([
          structurePhase, frameworkPhase, markdownPhase, parseEmitPhase,
          resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase,
          mroPhase, communityPhase, processTracingPhase, accessTrackingPhase,
          coveragePhase,
          cobolPhase,
          callResolutionPhase, scopeResolutionPhase, securityScanPhase,
        ], context);
        nodeCount = graph.nodeCount;
        edgeCount = graph.relationshipCount;
        log.info('Full analysis complete', { nodes: nodeCount, edges: edgeCount });
        // #732: Capture pipeline context for --profile / benchmark output
        profileCtx = context;
      }

      // #732: Emit structured profile/benchmark output to stderr
      if (opts.profile && profileCtx) {
        const timing = profileCtx.state.get(PIPELINE_TIMING_KEY) as PhaseTimerResult | undefined;
        const mem = profileCtx.state.get(PIPELINE_MEMORY_KEY) as { before: NodeJS.MemoryUsage; after: NodeJS.MemoryUsage } | undefined;
        const profileData = {
          version: pkg.version,
          timestamp: new Date().toISOString(),
          phases: timing?.phases ?? {},
          totalMs: timing?.totalMs ?? 0,
          memory: mem ?? null,
          nodeCount,
          edgeCount,
        };
        // Emit structured JSON to stderr so piped/scripted consumers can capture it
        console.error('---ASTROLABE_PROFILE_START---');
        console.error(JSON.stringify(profileData, null, 2));
        console.error('---ASTROLABE_PROFILE_END---');
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
          noStats: opts.noStats ?? false,
        });
        log.info('Agent files generated', { agentsMd: agentResult.agentsMd, claudeMd: agentResult.claudeMd, skillsCount: agentResult.skillsCount });
      }

      log.info('Analysis complete', { nodes: nodeCount, edges: edgeCount, repo: repoName });
    } catch (err) {
      log.error('Analysis failed', { error: String(err) });
      process.exit(1);
    } finally {
      dbLock?.release();
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
  .option('-t, --transport <type>', 'Transport type: stdio (default) or http', 'stdio')
  .option('-p, --port <number>', 'Port for HTTP transport (default: 4748)', '4748')
  .option('-h, --host <host>', 'Host for HTTP transport (default: localhost)', 'localhost')
  .action(async (opts: { transport: string; port: string; host: string }) => {
    const transportType = opts.transport as 'stdio' | 'http';
    if (transportType !== 'stdio' && transportType !== 'http') {
      console.error(`Invalid transport: ${opts.transport}. Use 'stdio' or 'http'.`);
      process.exit(1);
    }

    if (transportType === 'stdio') {
      console.error('Astrolabe MCP server starting (stdio)...');
    }

    await startMcpServer({
      transport: transportType,
      port: parseInt(opts.port, 10),
      host: opts.host,
    });
  });

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

// ── watch ──────────────────────────────────────────────────────────────────────
program
  .command('watch <repo-path>')
  .description('Watch for file changes and incrementally re-index (#462)')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .option('--debounce <ms>', 'Debounce interval in milliseconds', parseInt, 500)
  .action(async (repoPath: string, opts: { db: string; logLevel: string; debounce: number }) => {
    const absRepo = resolve(repoPath);
    const dbPath = resolve(opts.db);

    console.log(`#462: Starting watch mode for ${absRepo}...`);
    console.log(`Database: ${dbPath}`);
    console.log('Press Ctrl+C to stop.');

    try {
      const watcher = await startWatch(absRepo, {
        dbPath,
        logLevel: opts.logLevel,
        debounceMs: opts.debounce,
      });

      // #462: Graceful shutdown on SIGINT/SIGTERM
      const shutdown = async () => {
        console.log('\nShutting down watcher...');
        await watcher.close();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err: any) {
      console.error(`Watch mode failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── index ────────────────────────────────────────────────────────────────────
program
  .command('index [path]')
  .description('Register an existing .astrolabe/ folder in the global registry without re-running analysis')
  .option('-d, --db <path>', 'Database path (default: <path>/.astrolabe/astrolabe.db)')
  .option('--force', 'Register even if meta.json is missing')
  .option('--allow-non-git', 'Allow non-git directories')
  .action((repoPath: string | undefined, opts: { db?: string; force?: boolean; allowNonGit?: boolean }) => {
    const resolvedPath = resolve(repoPath ?? '.');

    // Resolve db path — either explicit or default .astrolabe/astrolabe.db
    const dbPath = opts.db ? resolve(opts.db) : join(resolvedPath, '.astrolabe', 'astrolabe.db');
    const metaDir = dirname(dbPath);

    // Validate the DB exists and is readable
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error('Run `astrolabe analyze` first, or specify a valid --db path.');
      process.exit(1);
    }

    // Validate the database is a valid Astrolabe SQLite file
    let nodeCount = 0;
    let relCount = 0;
    try {
      const store = createSqliteStore(dbPath);
      try {
        nodeCount = store.getNodeCount();
        relCount = store.getRelationshipCount();
      } finally { store.close(); }
    } catch (err) {
      console.error(`Invalid database: ${dbPath}`, String(err));
      process.exit(1);
    }

    if (nodeCount === 0) {
      console.error(`Database is empty (0 nodes). Run \`astrolabe analyze\` first.`);
      process.exit(1);
    }

    // Check for meta.json (skip with --force)
    const meta = loadMeta(metaDir);
    if (!meta && !opts.force) {
      console.error(`meta.json not found in ${metaDir}. Use --force to register anyway.`);
      process.exit(1);
    }

    // Validate git repo (skip with --allow-non-git)
    let lastCommit = meta?.lastCommit ?? 'unknown';
    let remoteUrl: string | undefined;
    if (!opts.allowNonGit) {
      try {
        lastCommit = execSync('git rev-parse HEAD', { cwd: resolvedPath, encoding: 'utf-8' }).trim();
        remoteUrl = getGitRemote(resolvedPath) ?? undefined;
      } catch {
        console.error('Not a git repository. Use --allow-non-git to register anyway.');
        process.exit(1);
      }
    }

    // Register in global registry (same upsert pattern as analyze)
    const repoName = basename(resolvedPath);
    const repos = loadRegistry();
    const existingIdx = repos.findIndex((r) => r.path === resolvedPath);
    const entry = { name: repoName, path: resolvedPath, dbPath, lastCommit, indexedAt: Date.now(), remoteUrl };
    if (existingIdx >= 0) {
      repos[existingIdx] = entry;
      console.log(`Updated registry entry for "${repoName}".`);
    } else {
      repos.push(entry);
      console.log(`Registered "${repoName}" in global registry.`);
    }
    saveRegistry(repos);

    console.log(`  Path: ${resolvedPath}`);
    console.log(`  DB:   ${dbPath}`);
    console.log(`  Nodes: ${nodeCount}, Relationships: ${relCount}`);
    console.log(`  Commit: ${lastCommit}`);
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

// ── migrate ────────────────────────────────────────────────────────────────
// #771: GitNexus/LadybugDB → Astrolabe SQLite migration
program
  .command('migrate <source-path>')
  .description('Import GitNexus/LadybugDB analysis into Astrolabe SQLite format (#771)')
  .option('-o, --output <path>', 'Output database path', '.astrolabe/astrolabe.db')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .action((sourcePath: string, opts: { output: string; logLevel: string }) => {
    const absSource = resolve(sourcePath);
    const absOutput = resolve(opts.output);

    console.log(`Migrating GitNexus data from ${absSource}...`);
    try {
      const result = migrateFromGitNexus(absSource, absOutput);
      console.log(`Migration complete: ${result.nodeCount} nodes, ${result.edgeCount} edges`);
      if (result.warnings.length) {
        console.log(`Warnings (${result.warnings.length}):`);
        for (const w of result.warnings.slice(0, 10)) console.log(`  - ${w}`);
      }
      if (result.skippedTypes.length) {
        console.log(`Skipped types: ${result.skippedTypes.join(', ')}`);
      }
    } catch (err: any) {
      console.error(`Migration failed: ${err.message}`);
      process.exit(1);
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
  .option('--json', 'Output as JSON')
  .action((opts: { json?: boolean }) => {
    const groups = listGroups();
    if (opts.json) {
      console.log(JSON.stringify(groups, null, 2));
      return;
    }
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
  .option('--json', 'Output as JSON')
  .action((name: string, opts: { json?: boolean }) => {
    const status = getGroupStatus(name);
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`Group: ${status.name} (${status.repoCount} repos)`);
    for (const r of status.repos) {
      const staleIcon = r.stale ? '⚠' : '✓';
      const indexed = r.indexedAt ? new Date(r.indexedAt).toISOString() : 'never';
      console.log(`  ${staleIcon} ${r.path} → ${r.repoName} (indexed: ${indexed})`);
    }
    if (status.lastSyncAt) {
      console.log(`  Last sync: ${status.lastSyncAt}`);
    }
    if (status.recommendation) {
      console.log(`  → ${status.recommendation}`);
    }
  });

groupCmd.command('contracts <name>')
  .description('Inspect extracted cross-repo contracts for a group (#758)')
  .option('--type <type>', 'Filter by contract type (http, grpc, topic)')
  .option('--repo <repo>', 'Filter by repo name')
  .option('--unmatched', 'Show only low-confidence / unmatched contracts')
  .option('--json', 'Output as JSON')
  .action((name: string, opts: { type?: string; repo?: string; unmatched?: boolean; json?: boolean }) => {
    const contracts = getGroupContracts(name);
    if (!contracts) {
      if (opts.json) {
        console.log(JSON.stringify({ error: `No contracts extracted for group "${name}". Run group_sync first.` }, null, 2));
      } else {
        console.log(`No contracts extracted for group "${name}". Run "astrolabe group sync ${name}" first.`);
      }
      return;
    }

    // Apply filters
    let crossLinks = contracts.crossLinks;
    if (opts.type) {
      crossLinks = crossLinks.filter((cl) => cl.contractType === opts.type);
    }
    if (opts.repo) {
      crossLinks = crossLinks.filter((cl) =>
        cl.provider.repoName === opts.repo || cl.consumer.repoName === opts.repo);
    }
    if (opts.unmatched) {
      crossLinks = crossLinks.filter((cl) => cl.confidence < 0.5);
    }

    if (opts.json) {
      console.log(JSON.stringify({
        group: name,
        extractedAt: new Date(contracts.extractedAt).toISOString(),
        providerCount: contracts.providers.length,
        consumerCount: contracts.consumers.length,
        crossLinkCount: crossLinks.length,
        providers: contracts.providers,
        consumers: contracts.consumers,
        crossLinks,
        sharedLibs: (contracts as any).sharedLibs ?? [],
      }, null, 2));
      return;
    }

    const sharedLibCount = (contracts as any).sharedLibs?.length ?? 0;
    console.log(`Group: ${name}`);
    console.log(`Extracted: ${new Date(contracts.extractedAt).toISOString()}`);
    console.log(`Providers: ${contracts.providers.length}`);
    console.log(`Consumers: ${contracts.consumers.length}`);
    console.log(`Cross-links: ${crossLinks.length}${sharedLibCount > 0 ? `\nShared libraries: ${sharedLibCount}` : ''}`);
    console.log();

    if (crossLinks.length > 0) {
      for (const cl of crossLinks.slice(0, 50)) {
        const icon = cl.confidence >= 0.7 ? '✓' : cl.confidence >= 0.5 ? '~' : '?';
        console.log(`  ${icon} [${cl.contractType}] ${cl.provider.repoName} ${cl.provider.method} ${cl.provider.path}`);
        console.log(`      → ${cl.consumer.repoName} ${cl.consumer.functionName} (confidence: ${cl.confidence.toFixed(2)})`);
      }
      if (crossLinks.length > 50) {
        console.log(`  ... and ${crossLinks.length - 50} more`);
      }
    } else {
      console.log('  No cross-links found.');
    }
  });

groupCmd.command('query <name> <query>')
  .description('Search across all repos in a group (#758)')
  .option('--subgroup <prefix>', 'Limit to repos under a subgroup path prefix')
  .option('--limit <n>', 'Max results per repo', '5')
  .option('--json', 'Output as JSON')
  .action((name: string, query: string, opts: { subgroup?: string; limit?: string; json?: boolean }) => {
    const limit = parseInt(opts.limit ?? '5', 10);
    const results = groupQuery(name, query, limit);

    // Filter by subgroup prefix if specified
    const filtered = opts.subgroup
      ? results.filter((r) => r.repoName.startsWith(opts.subgroup!))
      : results;

    if (opts.json) {
      console.log(JSON.stringify({ group: name, query, limit, resultCount: filtered.reduce((s, r) => s + r.results.length, 0), results: filtered }, null, 2));
      return;
    }

    if (filtered.length === 0) {
      console.log('No results found across group repos.');
      return;
    }

    const totalResults = filtered.reduce((s, r) => s + r.results.length, 0);
    console.log(`Results for "${query}" in group "${name}" (${totalResults} matches across ${filtered.length} repos):`);

    for (const r of filtered) {
      console.log(`\n  === ${r.repoName} ===`);
      for (const rr of r.results) {
        console.log(`    ${rr.label.padEnd(12)} ${rr.name.padEnd(30)} ${rr.filePath}`);
      }
    }
  });

groupCmd.command('sync <name>')
  .description('Extract and cross-link HTTP contracts across group repos')
  .action((name: string) => {
    const results = syncGroupContracts(name);
    for (const r of results) {
      const icon = r.error ? '✗' : '✓';
      console.log(`  ${icon} ${r.repoName}: ${r.providerCount} providers, ${r.consumerCount} consumers, ${r.crossLinks} cross-links${r.error ? ` (${r.error})` : ''}`);
    }
    const totalLinks = results.reduce((sum, r) => sum + r.crossLinks, 0);
    console.log(`\nTotal cross-repo links: ${totalLinks}`);
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
  .option('--provider <provider>', 'LLM provider (openai, anthropic, ollama, openrouter, azure) (#763)')
  .option('--api-key <key>', 'LLM API key (overrides env var)')
  .option('--force', 'Force full regeneration of wiki')
  .option('--review', 'Stop after module tree creation for review (#452)')
  .option('--resume', 'Resume from edited module tree (#452)')
  .option('--gist', 'Publish wiki to GitHub Gist after generation (#452)')
  .option('--concurrency <n>', 'Max concurrent LLM calls (default: 1)', parseInt)
  .option('--reasoning-model', 'Force reasoning model prompt mode (for o1/o3/o4-mini)')
  .option('--no-reasoning-model', 'Disable reasoning model detection')
  .action(async (repoPath: string, opts: { model?: string; baseUrl?: string; provider?: string; apiKey?: string; force?: boolean; review?: boolean; resume?: boolean; gist?: boolean; concurrency?: number; reasoningModel?: boolean; noReasoningModel?: boolean }) => {
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
      model: opts.model, baseUrl: opts.baseUrl, apiKey: opts.apiKey,
      provider: opts.provider, force: opts.force,
      review: opts.review, resume: opts.resume, gist: opts.gist,
      concurrency: opts.concurrency,
      reasoningModel: opts.noReasoningModel ? false : opts.reasoningModel,
    });

    console.log(`Wiki generated: ${result.pageCount} pages, ${result.moduleCount} modules`);
    console.log(`Overview: ${result.overviewPath}`);
    if (result.gistUrl) {
      console.log(`Gist: ${result.gistUrl}`);
    }
  });

// ── analyze-architecture ──────────────────────────────────────────────────────
program
  .command('analyze-architecture [repoPath]')
  .description('Detect architectural patterns using graphlet-based structural analysis (#461)')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .option('--json', 'Output raw JSON')
  .action((repoPath: string | undefined, opts: { db: string; json?: boolean }) => {
    const dbPath = repoPath ? join(repoPath, '.astrolabe', 'astrolabe.db') : opts.db;
    if (!existsSync(dbPath)) {
      console.log('No knowledge graph found. Run `astrolabe analyze` first.');
      return;
    }

    const store = createSqliteStore(dbPath);
    const graph = store.loadGraph();
    store.close();

    // Build adjacency map from CALLS, IMPORTS, EXTENDS edges
    const nodeIds = new Set<string>();
    for (const node of graph.iterNodes()) nodeIds.add(node.id);
    const adjMap = buildAdjacencyMap(graph.iterRelationships(), nodeIds);
    const profile = countGraphlets(graph.iterNodes(), adjMap);

    // Extract community info from Community nodes
    const communities: Array<{ id: string; nodeCount: number }> = [];
    for (const node of graph.iterNodes()) {
      if (node.label === 'Community') {
        communities.push({ id: node.id, nodeCount: (node.properties.symbolCount as number) ?? 0 });
      }
    }

    const patterns = detectPatterns(profile);
    const health = scoreArchitectureHealth(profile, communities, adjMap);

    if (opts.json) {
      console.log(JSON.stringify({ profile, patterns, health }, null, 2));
      return;
    }

    const totalMotifs3 = profile.motif3.empty + profile.motif3.oneEdge + profile.motif3.twoEdge + profile.motif3.triangle;
    const totalMotifs4 = profile.motif4.chain + profile.motif4.star + profile.motif4.diamond + profile.motif4.cycle + profile.motif4.clique;

    console.log(`\n=== Architecture Analysis ===`);
    console.log(`Nodes: ${profile.nodeCount} | Edges: ${profile.edgeCount} | ${profile.sampled ? `Sampled (${profile.sampleSize} nodes)` : 'Full enumeration'}`);
    console.log(`\n--- 3-Node Motifs (${totalMotifs3} total) ---`);
    console.log(`  empty:    ${profile.motif3.empty}`);
    console.log(`  oneEdge:  ${profile.motif3.oneEdge}`);
    console.log(`  twoEdge:  ${profile.motif3.twoEdge}`);
    console.log(`  triangle: ${profile.motif3.triangle}`);
    console.log(`\n--- 4-Node Motifs (${totalMotifs4} total) ---`);
    console.log(`  chain:   ${profile.motif4.chain}`);
    console.log(`  star:    ${profile.motif4.star}`);
    console.log(`  diamond: ${profile.motif4.diamond}`);
    console.log(`  cycle:   ${profile.motif4.cycle}`);
    console.log(`  clique:  ${profile.motif4.clique}`);
    console.log(`\n--- Detected Patterns ---`);
    for (const p of patterns) console.log(`  ${p.name}: ${(p.confidence * 100).toFixed(0)}% — ${p.description}`);
    console.log(`\n--- Health Score: ${health.overallScore}/100 ---`);
    console.log(`  Cohesion: ${(health.cohesion * 100).toFixed(1)}% | Modularity: ${(health.modularity * 100).toFixed(1)}% | Complexity: ${(health.complexity * 100).toFixed(1)}%`);
    if (health.antiPatterns.length > 0) {
      console.log(`\n--- Anti-Patterns ---`);
      for (const ap of health.antiPatterns) console.log(`  [${ap.severity}] ${ap.name}: ${ap.description}`);
    }
    console.log();
  });

// ── ingest-coverage (#463) ──────────────────────────────────────────────────
program
  .command('ingest-coverage <report-file>')
  .description('Import test coverage data into the knowledge graph (#463)')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .option('--format <type>', 'Coverage format: lcov, istanbul, cobertura (auto-detected if omitted)')
  .option('--repo <name>', 'Repository name (optional if only one indexed)')
  .option('--json', 'Output as JSON')
  .action(async (reportFile: string, opts: { db: string; format?: string; repo?: string; json?: boolean }) => {
    if (!existsSync(reportFile)) {
      console.error(`Coverage report not found: ${reportFile}`);
      process.exit(1);
    }

    if (!existsSync(opts.db)) {
      console.error('No analysis found. Run `astrolabe analyze <repo>` first.');
      process.exit(1);
    }

    // #463: Read and parse coverage report
    const content = readFileSync(resolve(reportFile), 'utf-8');
    const format = (opts.format as 'lcov' | 'istanbul' | 'cobertura' | undefined) ?? detectFormat(content);
    if (!format) {
      console.error('Could not detect coverage format. Use --format to specify: lcov, istanbul, or cobertura.');
      process.exit(1);
    }

    const report = parseCoverageReport(content, format);

    // Load graph from DB
    const store = createSqliteStore(opts.db);
    try {
      const graph = store.loadGraph();
      const result = annotateGraphWithCoverage(graph, report);

      // Save annotated graph back to DB
      store.saveGraph(graph);

      if (opts.json) {
        console.log(JSON.stringify({
          format,
          report: {
            files: report.files.length,
            totalLines: report.totalLines,
            coveredLines: report.coveredLines,
            lineCoveragePercent: report.lineCoveragePercent.toFixed(1),
            totalFunctions: report.totalFunctions,
            coveredFunctions: report.coveredFunctions,
            functionCoveragePercent: report.functionCoveragePercent.toFixed(1),
          },
          annotation: result,
        }, null, 2));
      } else {
        console.log(`Coverage report ingested (${format} format):`);
        console.log(`  Files in report: ${report.files.length}`);
        console.log(`  Line coverage:   ${report.coveredLines}/${report.totalLines} (${report.lineCoveragePercent.toFixed(1)}%)`);
        console.log(`  Function coverage: ${report.coveredFunctions}/${report.totalFunctions} (${report.functionCoveragePercent.toFixed(1)}%)`);
        console.log(`  Graph nodes annotated: ${result.filesProcessed} files`);
        console.log(`  Uncovered nodes: ${result.uncoveredNodes}`);
      }
    } finally {
      store.close();
    }
  });

// ── scan-secrets ──────────────────────────────────────────────────────────────
program
  .command('scan-secrets [repo-path]')
  .description('Scan for secrets and security-sensitive patterns in indexed code (#464)')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .option('--check-deps', 'Also check dependencies for vulnerabilities via OSV.dev')
  .option('--severity <level>', 'Minimum severity to report', 'low')
  .option('--json', 'Output as JSON')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (repoPath?: string, opts?: { db: string; checkDeps: boolean; severity: string; json: boolean; logLevel: string }) => {
    const dbPath = resolve(opts?.db ?? '.astrolabe/astrolabe.db');
    if (!existsSync(dbPath)) {
      console.log('No analysis found. Run `astrolabe analyze <repo>` first.');
      return;
    }

    const store = createSqliteStore(dbPath);
    try {
      const graph = store.loadGraph();
      const severityThreshold = opts?.severity ?? 'low';

      // #464: Import scan helpers
      const { meetsSeverity } = await import('@astrolabe-dev/core');

      // Secret patterns
      const SECRET_PATTERNS = [
        { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/g, severity: 'critical' as const },
        { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"][A-Za-z0-9/+=]{40}['"]/gi, severity: 'critical' as const },
        { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, severity: 'critical' as const },
        { name: 'GitHub OAuth', pattern: /gho_[A-Za-z0-9]{36}/g, severity: 'critical' as const },
        { name: 'Slack Token', pattern: /xox[baprs]-[0-9]{10,}-[A-Za-z0-9]+/g, severity: 'high' as const },
        { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, severity: 'critical' as const },
        { name: 'JWT', pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, severity: 'medium' as const },
        { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"][A-Za-z0-9]{20,}['"]/gi, severity: 'high' as const },
        { name: 'Generic Secret', pattern: /(?:secret|password|token)\s*[=:]\s*['"][A-Za-z0-9!@#$%^&*]{16,}['"]/gi, severity: 'high' as const },
        { name: 'Google API Key', pattern: /AIza[0-9A-Za-z_-]{35}/g, severity: 'high' as const },
        { name: 'Stripe Key', pattern: /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{24,}/g, severity: 'critical' as const },
      ];

      const SECURITY_PATTERNS = [
        { category: 'auth', patterns: [/\b(?:login|authenticate|authorize|logout|session)\b/i], severity: 'medium' as const },
        { category: 'crypto', patterns: [/\b(?:encrypt|decrypt|hash|sign|verify|cipher|digest)\b/i], severity: 'medium' as const },
        { category: 'sql', patterns: [/\b(?:executeQuery|rawQuery|\.query\(|sql.*\+|SELECT.*FROM|INSERT.*INTO)\b/i], severity: 'high' as const },
        { category: 'file-io', patterns: [/\b(?:readFile|writeFile|unlink|rmdir|exec|spawn)\b/i], severity: 'low' as const },
        { category: 'network', patterns: [/\b(?:fetch|axios|http\.request|XMLHttpRequest|websocket)\b/i], severity: 'info' as const },
      ];

      const binaryExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'zip', 'gz', 'tar', 'wasm']);

      const findings: Array<{ type: string; severity: string; category: string; message: string; nodeId: string; filePath: string }> = [];
      let secretCount = 0;
      let securityPatternCount = 0;

      for (const node of graph.iterNodes()) {
        const content = typeof node.properties.content === 'string' ? node.properties.content : '';
        const name = typeof node.properties.name === 'string' ? node.properties.name : '';
        const filePath = typeof node.properties.filePath === 'string' ? node.properties.filePath : '';
        if (!filePath) continue;

        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        if (binaryExtensions.has(ext)) continue;

        // Secret scanning
        if (content) {
          for (const { name: patternName, pattern, severity } of SECRET_PATTERNS) {
            if (!meetsSeverity(severity, severityThreshold)) continue;
            const regex = new RegExp(pattern.source, pattern.flags);
            if (regex.test(content)) {
              secretCount++;
              findings.push({ type: 'secret', severity, category: patternName, message: `Detected ${patternName} in ${node.label} "${name || node.id}"`, nodeId: node.id, filePath });
            }
          }
        }

        // Security pattern scanning
        const textToScan = [name, content].filter(Boolean).join(' ');
        if (textToScan) {
          for (const { category, patterns, severity } of SECURITY_PATTERNS) {
            if (!meetsSeverity(severity, severityThreshold)) continue;
            for (const pat of patterns) {
              const regex = new RegExp(pat.source, pat.flags);
              if (regex.test(textToScan)) {
                securityPatternCount++;
                findings.push({ type: 'security-pattern', severity, category, message: `Security-sensitive ${category} pattern in ${node.label} "${name || node.id}"`, nodeId: node.id, filePath });
                break;
              }
            }
          }
        }
      }

      // Dependency vulnerability check
      let vulnReport: unknown = null;
      if (opts?.checkDeps) {
        try {
          const { detectManifestFiles, parseManifest, checkVulnerabilities } = await import('@astrolabe-dev/core');
          const targetPath = repoPath ?? dirname(dbPath);
          const manifests = detectManifestFiles(targetPath);
          const allDeps: Array<{ name: string; version: string; ecosystem: string }> = [];
          for (const m of manifests) {
            const deps = parseManifest(m.path, m.ecosystem);
            allDeps.push(...deps);
          }
          if (allDeps.length > 0) {
            vulnReport = await checkVulnerabilities(allDeps);
          }
        } catch (err) {
          vulnReport = { error: `Dependency check failed: ${String(err)}` };
        }
      }

      if (opts?.json) {
        console.log(JSON.stringify({ findings, summary: { totalFindings: findings.length, secretCount, securityPatternCount }, vulnerabilities: vulnReport }, null, 2));
      } else {
        console.log(`Security Scan Results`);
        console.log(`=====================`);
        console.log(`Secrets found: ${secretCount}`);
        console.log(`Security patterns: ${securityPatternCount}`);
        console.log(`Total findings: ${findings.length}`);
        console.log();

        if (findings.length > 0) {
          // Group by severity
          const bySeverity = new Map<string, typeof findings>();
          for (const f of findings) {
            const arr = bySeverity.get(f.severity) ?? [];
            arr.push(f);
            bySeverity.set(f.severity, arr);
          }
          for (const [sev, items] of bySeverity) {
            console.log(`[${sev.toUpperCase()}] (${items.length} findings)`);
            for (const f of items.slice(0, 20)) {
              console.log(`  ${f.type}: ${f.message} (${f.filePath})`);
            }
            if (items.length > 20) console.log(`  ... and ${items.length - 20} more`);
            console.log();
          }
        }

        if (vulnReport) {
          console.log('Dependency Vulnerabilities:');
          console.log(JSON.stringify(vulnReport, null, 2));
        }
      }
    } finally {
      store.close();
    }
  });

// ── resilience (#805) ─────────────────────────────────────────────────────────
program
  .command('resilience [repoPath]')
  .description('Analyze graph resilience — detect single points of failure (SPoF) and critical edges')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .option('--json', 'Output raw JSON')
  .action((repoPath: string | undefined, opts: { db: string; json?: boolean }) => {
    const dbPath = repoPath ? join(repoPath, '.astrolabe', 'astrolabe.db') : opts.db;
    if (!existsSync(dbPath)) {
      console.log('No knowledge graph found. Run `astrolabe analyze` first.');
      return;
    }

    const store = createSqliteStore(dbPath);
    try {
      const graph = store.loadGraph();

      // Build adjacency list from CALLS and IMPORTS edges (same as MCP handler)
      const adjList = new Map<string, string[]>();
      for (const node of graph.iterNodes()) {
        if (!adjList.has(node.id)) adjList.set(node.id, []);
      }
      for (const rel of graph.iterRelationships()) {
        if (rel.type === 'STEP_IN_PROCESS' || rel.type === 'MEMBER_OF' || rel.type === 'ENTRY_POINT_OF') continue;
        if (rel.type !== 'CALLS' && rel.type !== 'IMPORTS') continue;
        let targets = adjList.get(rel.sourceId);
        if (!targets) { targets = []; adjList.set(rel.sourceId, targets); }
        targets.push(rel.targetId);
        if (!adjList.has(rel.targetId)) adjList.set(rel.targetId, []);
      }

      const cutVertices = detectCutVertices(adjList);
      const bridges = detectBridges(adjList);

      // Resolve names
      const namedCutVertices = cutVertices.map((id: string) => {
        const node = graph.getNode(id);
        return { id, name: node?.properties.name ?? id };
      });

      const namedBridges = bridges.map((b: { source: string; target: string }) => {
        const srcNode = graph.getNode(b.source);
        const tgtNode = graph.getNode(b.target);
        return {
          source: { id: b.source, name: srcNode?.properties.name ?? b.source },
          target: { id: b.target, name: tgtNode?.properties.name ?? b.target },
        };
      });

      const nodeCount = adjList.size;
      const edgeCount = Array.from(adjList.values()).reduce((s, t) => s + t.length, 0);

      if (opts.json) {
        console.log(JSON.stringify({
          nodeCount,
          edgeCount,
          cutVertices: { count: cutVertices.length, nodes: namedCutVertices },
          bridgeEdges: { count: bridges.length, edges: namedBridges },
          isBiconnected: cutVertices.length === 0 && bridges.length === 0,
        }, null, 2));
        return;
      }

      console.log(`\n=== Graph Resilience Analysis ===`);
      console.log(`Nodes: ${nodeCount} | Edges: ${edgeCount}`);
      console.log();

      if (cutVertices.length === 0 && bridges.length === 0) {
        console.log('\u2713 The graph is biconnected \u2014 no single points of failure detected.');
      } else {
        if (cutVertices.length > 0) {
          console.log(`--- Single Points of Failure (${cutVertices.length} cut vertices) ---`);
          console.log('These nodes, if removed, would disconnect the dependency graph:');
          for (const n of namedCutVertices.slice(0, 20)) {
            console.log(`  \u26A0  ${n.name}`);
          }
          if (namedCutVertices.length > 20) {
            console.log(`  ... and ${namedCutVertices.length - 20} more`);
          }
          console.log();
        }

        if (bridges.length > 0) {
          console.log(`--- Critical Dependency Bridges (${bridges.length} bridge edges) ---`);
          console.log('These edges are the ONLY connection between subsystems:');
          for (const b of namedBridges.slice(0, 20)) {
            console.log(`  \u26A1 ${b.source.name} \u2192 ${b.target.name}`);
          }
          if (namedBridges.length > 20) {
            console.log(`  ... and ${namedBridges.length - 20} more`);
          }
          console.log();
        }
      }
    } finally {
      store.close();
    }
  });

program.parse();
