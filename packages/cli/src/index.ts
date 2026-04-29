#!/usr/bin/env node
/**
 * @astrolabe/cli — CLI entry point with full command suite.
 */
import { program } from 'commander';
import { readFileSync, existsSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  createKnowledgeGraph, scanPhase, structurePhase, frameworkPhase, markdownPhase, parseEmitPhase,
  resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase,
  mroPhase, communityPhase, processTracingPhase,
  initParser, createSqliteStore, createFtsSearch,
  createLogger, createPhaseContext, runPipeline, startMcpServer,
  loadRegistry, saveRegistry,
  generateSkill,
  loadMeta, saveMeta, computeFileDiff, buildMeta,
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
  .action(async (repoPath: string, opts: { output: string; logLevel: string }) => {
    const log = createLogger({ level: opts.logLevel as any });
    log.info('Starting analysis', { repoPath, output: opts.output });
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

      if (storedMeta && dbExists) {
        // ── Incremental mode ──
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

        // Run remaining phases with file filter
        const ctx = createPhaseContext(repoPath, graph, onProgress);
        ctx.state.set('output:scan', scanOutput);
        ctx.state.set('incremental:changedPaths', new Set([...diff.changed, ...diff.added]));
        await runPipeline([
          structurePhase, frameworkPhase, markdownPhase, parseEmitPhase,
          resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase,
          mroPhase, communityPhase, processTracingPhase,
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
        ], context);
        nodeCount = graph.nodeCount;
        edgeCount = graph.relationshipCount;
        log.info('Full analysis complete', { nodes: nodeCount, edges: edgeCount });
      }

      // Save graph to SQLite
      const store = createSqliteStore(dbPath);
      store.saveGraph(graph);
      const fts = createFtsSearch(dbPath);
      fts.indexGraph(store);
      fts.close();
      store.close();

      // Save meta.json with current file hashes for next incremental run
      saveMeta(dirname(dbPath), buildMeta(currentHashes, lastCommit));

      // Register repo in global registry for multi-repo MCP support
      const repos = loadRegistry();
      const existingIdx = repos.findIndex((r) => r.path === repoPath);
      const entry = { name: repoName, path: repoPath, dbPath, lastCommit, indexedAt: Date.now() };
      if (existingIdx >= 0) repos[existingIdx] = entry; else repos.push(entry);
      saveRegistry(repos);

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

program.parse();
