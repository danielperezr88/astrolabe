#!/usr/bin/env node
/**
 * @astrolabe/cli — CLI entry point with full command suite.
 */
import { program } from 'commander';
import { readFileSync, existsSync, statSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  createKnowledgeGraph, scanPhase, structurePhase, parseEmitPhase,
  resolutionPhase, mroPhase, communityPhase, processTracingPhase,
  initParser, createSqliteStore, createFtsSearch,
  createLogger, createPhaseContext, runPipeline, startMcpServer,
} from '@astrolabe/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const REGISTRY_DIR = join(homedir(), '.astrolabe');
const REGISTRY_FILE = join(REGISTRY_DIR, 'registry.json');

function loadRegistry(): Array<{ name: string; path: string; dbPath: string; lastCommit: string; indexedAt: number }> {
  try { if (!existsSync(REGISTRY_FILE)) return []; return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8')); }
  catch { return []; }
}

function saveRegistry(entries: Array<{ name: string; path: string; dbPath: string; lastCommit: string; indexedAt: number }>): void {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2));
}

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
      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repoPath, graph, () => undefined);
      // Run ALL phases in ONE pipeline call so dependencies are satisfied (#54)
      // Full DAG: scan -> structure -> parse-emit -> resolution -> mro -> community -> process-tracing
      await runPipeline([
        scanPhase, structurePhase, parseEmitPhase, resolutionPhase,
        mroPhase, communityPhase, processTracingPhase,
      ], context);
      // Ensure output directory exists (#58)
      const outDir = dirname(opts.output);
      if (outDir !== '.' && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      const store = createSqliteStore(opts.output);
      store.saveGraph(graph);
      const nodeCount = graph.nodeCount;
      const edgeCount = graph.relationshipCount;
      store.close();

      // Register repo in global registry for multi-repo MCP support
      const absDb = join(repoPath, opts.output);
      const repos = loadRegistry();
      const repoName = basename(repoPath);
      const existingIdx = repos.findIndex((r) => r.path === repoPath);
      const entry = { name: repoName, path: repoPath, dbPath: absDb, lastCommit: getGitCommit(repoPath), indexedAt: Date.now() };
      if (existingIdx >= 0) repos[existingIdx] = entry; else repos.push(entry);
      saveRegistry(repos);

      log.info('Analysis complete', { nodes: nodeCount, edges: edgeCount, registered: repoName });
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
      let found = 0;
      for (const node of graph.iterNodes()) {
        if (node.properties.name === symbolName) {
          found++;
          console.log(`${node.label}: ${node.id}`);
          for (const rel of graph.iterRelationships()) {
            if (rel.sourceId === node.id || rel.targetId === node.id) {
              const oid = rel.sourceId === node.id ? rel.targetId : rel.sourceId;
              const other = graph.getNode(oid);
              console.log(`  ${rel.sourceId === node.id ? '→' : '←'} ${rel.type} ${other?.properties.name ?? oid}`);
            }
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

program.parse();
