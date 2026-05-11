/**
 * Watch Mode — File watching with incremental re-indexing (#462).
 *
 * Monitors a codebase for changes and incrementally re-indexes affected files
 * using chokidar for file watching and the existing incremental pipeline.
 */
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { resolve, relative, basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import {
  createSqliteStore,
  createKnowledgeGraph,
  scanPhase,
  structurePhase,
  frameworkPhase,
  markdownPhase,
  parseEmitPhase,
  resolutionPhase,
  routesPhase,
  toolsPhase,
  ormPhase,
  crossFilePhase,
  mroPhase,
  communityPhase,
  processTracingPhase,
  accessTrackingPhase,
  cobolPhase,
  callResolutionPhase,
  scopeResolutionPhase,
  createPhaseContext,
  runPipeline,
  initParser,
  createLogger,
  loadMeta,
  saveMeta,
  buildMeta,
} from '@astrolabe-dev/core';
import type { IncrementalInfo, KnowledgeGraph, SqliteStore } from '@astrolabe-dev/core';

// #462: Debounce interval to avoid processing the same file multiple times in quick succession
const DEFAULT_DEBOUNCE_MS = 500;

// #462: Glob patterns for files and directories to ignore during watching
const IGNORED_GLOBS: string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.astrolabe/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/*.swp',
  '**/*.swo',
  '**/*~',
];

export interface WatchOptions {
  dbPath?: string;
  logLevel?: string;
  debounceMs?: number;
  onProgress?: (message: string) => void;
}

/**
 * #462: Start watching a repository for file changes and incrementally re-index.
 *
 * Loads the existing knowledge graph from SQLite, monitors the repo with chokidar,
 * and re-runs the incremental pipeline when files change, are added, or deleted.
 *
 * Returns the FSWatcher so callers can close it (e.g. on SIGINT/SIGTERM).
 */
export async function startWatch(repoPath: string, opts: WatchOptions = {}): Promise<FSWatcher> {
  const absRepo = resolve(repoPath);
  const dbName = basename(absRepo);
  const dbPath = opts.dbPath || resolve(absRepo, '.astrolabe', 'astrolabe.db');
  const log = createLogger({ level: (opts.logLevel as any) ?? 'info' });
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  // #462: Require an existing analysis — user must run `astrolabe analyze` first
  if (!existsSync(dbPath)) {
    throw new Error('No existing analysis found. Run `astrolabe analyze` first.');
  }

  // Initialize the tree-sitter parser (needed by pipeline phases)
  await initParser();

  const store: SqliteStore = createSqliteStore(dbPath);
  const graph: KnowledgeGraph = store.loadGraph();
  log.info(`Loaded ${graph.nodeCount} nodes, ${graph.relationshipCount} relationships from ${dbName}`);

  // #462: Pending file changes, debounced to batch rapid events
  const pendingChanges = new Map<string, 'change' | 'add' | 'unlink'>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isProcessing = false;

  /**
   * #462: Process all pending file changes in a single batch.
   *
   * Removes nodes for changed/deleted files, re-runs the incremental pipeline
   * for changed/added files, and persists the updated graph.
   */
  async function processChanges(): Promise<void> {
    if (pendingChanges.size === 0) return;
    if (isProcessing) {
      // Schedule re-process after current batch finishes
      scheduleProcess();
      return;
    }

    isProcessing = true;

    // Snapshot and clear pending changes
    const changes = new Map(pendingChanges);
    pendingChanges.clear();
    debounceTimer = null;

    const changedPaths = new Set<string>();
    const addedPaths = new Set<string>();
    const deletedPaths = new Set<string>();

    for (const [filePath, eventType] of changes) {
      const relPath = relative(absRepo, filePath).replace(/\\/g, '/');
      if (eventType === 'unlink') {
        deletedPaths.add(relPath);
      } else if (eventType === 'add') {
        addedPaths.add(relPath);
      } else {
        changedPaths.add(relPath);
      }
    }

    log.info(`Processing ${changes.size} file change(s): ${changedPaths.size} changed, ${addedPaths.size} added, ${deletedPaths.size} deleted`);

    // #462: Remove nodes for changed and deleted files
    for (const fp of [...changedPaths, ...deletedPaths]) {
      const removed = graph.removeNodesByFile(fp);
      if (removed > 0) log.debug(`Removed ${removed} nodes for ${fp}`);
    }

    // #462: Re-run phases with incremental context for changed/added files
    if (changedPaths.size > 0 || addedPaths.size > 0) {
      const incrementalInfo: IncrementalInfo = {
        changedPaths,
        addedPaths,
        deletedPaths,
        unchangedPaths: new Set(),
        isIncremental: true,
      };

      const context = createPhaseContext(absRepo, graph, (msg) => log.info(msg), incrementalInfo);

      // Pass file info so incremental phases know which files changed
      context.state.set('incremental:changedPaths', new Set([...changedPaths, ...addedPaths]));

      try {
        await runPipeline([
          structurePhase, frameworkPhase, markdownPhase, parseEmitPhase,
          resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase,
          mroPhase, communityPhase, processTracingPhase, accessTrackingPhase,
          cobolPhase, callResolutionPhase, scopeResolutionPhase,
        ], context);
      } catch (err: any) {
        log.error('Incremental pipeline failed', { error: err.message });
      }
    }

    // #462: Persist updated graph
    store.saveGraph(graph);
    log.info(`Updated graph: ${graph.nodeCount} nodes, ${graph.relationshipCount} relationships`);

    // #462: Update meta.json with fresh hashes for changed/added files
    try {
      const metaDir = dirname(dbPath);
      const existingMeta = loadMeta(metaDir);
      if (existingMeta) {
        // Re-scan to get fresh file hashes, then update meta
        const scanGraph = createKnowledgeGraph();
        const scanCtx = createPhaseContext(absRepo, scanGraph, () => {});
        await runPipeline([scanPhase], scanCtx);
        const scanOutput = scanCtx.state.get('output:scan') as any;
        if (scanOutput) {
          const hashes = new Map<string, string>();
          for (const f of scanOutput.files) hashes.set(f.path, f.hash);
          const execSync = (await import('node:child_process')).execSync;
          let lastCommit = 'unknown';
          try { lastCommit = execSync('git rev-parse HEAD', { cwd: absRepo, encoding: 'utf-8' }).trim(); } catch { /* not a git repo */ }
          saveMeta(metaDir, buildMeta(hashes, lastCommit));
        }
      }
    } catch (metaErr: any) {
      log.warn('Failed to update meta.json', { error: metaErr.message });
    }

    if (opts.onProgress) opts.onProgress(`Re-indexed ${changes.size} files`);
    isProcessing = false;
  }

  function scheduleProcess(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      processChanges().catch((err) => log.error('Error processing changes', { error: String(err) }));
    }, debounceMs);
  }

  // #462: Start watching with chokidar
  const watcher: FSWatcher = chokidarWatch(absRepo, {
    ignored: IGNORED_GLOBS,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', (filePath: string) => {
    log.debug(`File added: ${filePath}`);
    pendingChanges.set(filePath, 'add');
    scheduleProcess();
  });

  watcher.on('change', (filePath: string) => {
    log.debug(`File changed: ${filePath}`);
    pendingChanges.set(filePath, 'change');
    scheduleProcess();
  });

  watcher.on('unlink', (filePath: string) => {
    log.debug(`File deleted: ${filePath}`);
    pendingChanges.set(filePath, 'unlink');
    scheduleProcess();
  });

  watcher.on('ready', () => {
    log.info(`Watching ${dbName} for changes... (Ctrl+C to stop)`);
  });

  watcher.on('error', (err: Error) => {
    log.error('Watcher error', { error: String(err) });
  });

  return watcher;
}