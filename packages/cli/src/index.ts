#!/usr/bin/env node
/**
 * @astrolabe/cli — CLI entry point with full command suite.
 */

import { program } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnowledgeGraph, scanPhase, structurePhase, parseEmitPhase, resolutionPhase, initParser, createSqliteStore, createFtsSearch, createLogger, createPhaseContext, runPipeline, startMcpServer } from '@astrolabe/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

program
  .name('astrolabe')
  .description('Codebase knowledge graph analysis tool')
  .version(pkg.version);

program
  .command('version')
  .description('Show version information')
  .action(() => {
    console.log(`astrolabe v${pkg.version}`);
  });

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

      log.phaseStart('scan');
      await runPipeline([scanPhase], context);
      log.phaseEnd('scan');

      log.phaseStart('structure');
      await runPipeline([structurePhase], context);
      log.phaseEnd('structure');

      log.phaseStart('parse-emit');
      await runPipeline([parseEmitPhase], context);
      log.phaseEnd('parse-emit');

      log.phaseStart('resolution');
      await runPipeline([resolutionPhase], context);
      log.phaseEnd('resolution');

      // Persist
      const store = createSqliteStore(opts.output);
      store.saveGraph(graph);
      log.info('Analysis complete', { nodes: graph.nodeCount, edges: graph.relationshipCount });
      store.close();
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
      const results = fts.search(search, parseInt(opts.limit, 10));
      for (const r of results) {
        console.log(`${r.label.padEnd(12)} ${r.name.padEnd(30)} ${r.filePath}`);
      }
      if (results.length === 0) {
        console.log('No results found.');
      }
    } finally {
      fts.close();
    }
  });

// ── serve-mcp ────────────────────────────────────────────────────────────────

program
  .command('serve-mcp')
  .description('Start an MCP server (Model Context Protocol) for AI assistant integration')
  .action(async () => {
    console.error('Astrolabe MCP server starting...');
    await startMcpServer();
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show analysis status for the current repository')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .action((opts: { db: string }) => {
    const { existsSync, statSync } = require('node:fs');
    if (!existsSync(opts.db)) {
      console.log('No analysis found. Run `astrolabe analyze <repo>` first.');
      return;
    }
    const stats = statSync(opts.db);
    console.log(`Database: ${opts.db}`);
    console.log(`Size: ${(stats.size / 1024).toFixed(1)} KB`);
    console.log(`Last modified: ${stats.mtime.toISOString()}`);
    try {
      const { createSqliteStore } = require('@astrolabe/core');
      const store = createSqliteStore(opts.db);
      try {
        console.log(`Nodes: ${store.getNodeCount()}`);
        console.log(`Relationships: ${store.getRelationshipCount()}`);
      } finally {
        store.close();
      }
    } catch {
      console.log('Unable to read database. Run `astrolabe analyze <repo>` to rebuild.');
    }
  });

// ── clean ──────────────────────────────────────────────────────────────────────

program
  .command('clean')
  .description('Remove analysis artifacts (.astrolabe directory)')
  .action(() => {
    const { rmSync, existsSync } = require('node:fs');
    const path = '.astrolabe';
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
      console.log('Removed .astrolabe directory.');
    } else {
      console.log('No .astrolabe directory found.');
    }
  });

// ── context ────────────────────────────────────────────────────────────────────

program
  .command('context <symbol-name>')
  .description('Show the definition context for a symbol (file, imports, exports)')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .action((symbolName: string, opts: { db: string }) => {
    const fts = createFtsSearch(opts.db);
    try {
      const results = fts.search(symbolName, 5);
      if (results.length === 0) {
        console.log(`No symbols found matching "${symbolName}".`);
      } else {
        console.log(`Context for "${symbolName}":`);
        for (const r of results) {
          console.log(`  ${r.label} ${r.name}  (${r.filePath})`);
        }
      }
    } finally {
      fts.close();
    }
  });

// ── impact ─────────────────────────────────────────────────────────────────────

program
  .command('impact <symbol-name>')
  .description('Show code impact analysis for a symbol (callers, dependents)')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .action((symbolName: string, opts: { db: string }) => {
    const { createSqliteStore } = require('@astrolabe/core');
    const store = createSqliteStore(opts.db);
    try {
      const graph = store.loadGraph();
      let found = 0;
      for (const node of graph.iterNodes()) {
        if (node.properties.name === symbolName) {
          found++;
          console.log(`${node.label}: ${node.id}`);
          // Show relationships
          for (const rel of graph.iterRelationships()) {
            if (rel.sourceId === node.id || rel.targetId === node.id) {
              const otherId = rel.sourceId === node.id ? rel.targetId : rel.sourceId;
              const other = graph.getNode(otherId);
              const dir = rel.sourceId === node.id ? '→' : '←';
              console.log(`  ${dir} ${rel.type} ${other?.properties.name ?? otherId}`);
            }
          }
        }
      }
      if (found === 0) {
        console.log(`Symbol "${symbolName}" not found in the knowledge graph.`);
      }
    } finally {
      store.close();
    }
  });

// ── list ───────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List all symbols in the knowledge graph')
  .option('-d, --db <path>', 'Database path', '.astrolabe/astrolabe.db')
  .option('--label <label>', 'Filter by node label (Function, Class, etc.)')
  .action((opts: { db: string; label?: string }) => {
    const { createSqliteStore } = require('@astrolabe/core');
    const store = createSqliteStore(opts.db);
    try {
      const graph = store.loadGraph();
      let count = 0;
      for (const node of graph.iterNodes()) {
        if (opts.label && node.label !== opts.label) continue;
        count++;
        console.log(`${node.label.padEnd(12)} ${node.properties.name ?? '?'}  (${node.properties.filePath ?? '?'})`);
        if (count >= 100) {
          console.log('... (truncated at 100 results. Use `--label` to filter or `query` to search.)');
          break;
        }
      }
      if (count === 0) {
        console.log('No symbols found. Run `astrolabe analyze` first.');
      }
    } finally {
      store.close();
    }
  });
