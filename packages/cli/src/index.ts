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

program.parse();
