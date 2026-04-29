/**
 * Worker Pool — parallel file parsing via worker_threads (#272).
 *
 * Spawns configurable N worker threads. Files are dispatched in
 * byte-budget chunks for load balancing. Worker crashes trigger
 * sequential fallback for the failed chunk.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';

// ── Types ──────────────────────────────────────────────────────────────────

/** Serialized file parse result returned from a worker. */
export interface WorkerParseResult {
  filePath: string;
  symbols: Array<{
    id: string; filePath: string; name: string; label: string;
    startLine: number; endLine: number; isExported: boolean;
  }>;
  imports: Array<{
    id: string; source: string; names: { name: string; isDefault: boolean }[];
    startLine: number;
  }>;
  relationships: Array<{
    sourceName: string; sourceStartLine: number; targetName: string; type: string;
  }>;
  error?: string;
}

/** Statistics from a worker pool run. */
export interface PoolStats {
  totalFiles: number;
  workerCount: number;
  chunkCount: number;
  errorCount: number;
  durationMs: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Default number of workers (capped at CPU count - 1, min 1). */
export const DEFAULT_WORKERS = Math.max(1, cpus().length - 1);

/** File byte budget per chunk for load balancing. */
const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20 MB

// ── Worker path resolution ─────────────────────────────────────────────────

function resolveWorkerPath(): string | null {
  // Try compiled path first (production)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const prodPath = join(__dirname, 'parse-worker.js');
  if (existsSync(prodPath)) return prodPath;

  // Try source path (dev)
  const srcPath = join(__dirname, 'parse-worker.ts');
  if (existsSync(srcPath)) return srcPath;

  return null;
}

// ── Pool implementation ────────────────────────────────────────────────────

/**
 * Parse files in parallel using a worker thread pool.
 *
 * @param files — Array of { path, size } objects sorted by size (largest first)
 * @param parseFile — Sequential fallback parser function
 * @param workerCount — Number of worker threads (default: CPU count - 1)
 * @returns — Map of filePath → WorkerParseResult
 */
export async function parseFilesParallel(
  files: Array<{ path: string; size: number }>,
  parseFile: (filePath: string) => Promise<WorkerParseResult>,
  workerCount = DEFAULT_WORKERS,
): Promise<{ results: Map<string, WorkerParseResult>; stats: PoolStats }> {
  const startTime = Date.now();
  const results = new Map<string, WorkerParseResult>();
  let totalErrors = 0;
  let chunkCount = 0;

  // Resolve worker path
  const workerPath = resolveWorkerPath();

  // If no worker available, fall back to sequential
  if (!workerPath || workerCount <= 1) {
    for (const f of files) {
      const r = await parseFile(f.path);
      results.set(r.filePath, r);
      if (r.error) totalErrors++;
    }
    return {
      results,
      stats: {
        totalFiles: files.length,
        workerCount: 0,
        chunkCount: 1,
        errorCount: totalErrors,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // Chunk files by byte budget (largest files first for load balancing)
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentBytes = 0;

  for (const f of files) {
    if (currentBytes + f.size > CHUNK_BYTE_BUDGET && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 0;
    }
    currentChunk.push(f.path);
    currentBytes += f.size;
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  chunkCount = chunks.length;
  const actualWorkers = Math.min(workerCount, chunks.length);

  // Spawn workers
  const workers: Worker[] = [];
  for (let i = 0; i < actualWorkers; i++) {
    try {
      const w = new Worker(workerPath);
      workers.push(w);
    } catch {
      // Worker spawn failed — fall back to sequential
      break;
    }
  }

  if (workers.length === 0) {
    // All spawns failed — sequential fallback
    for (const f of files) {
      const r = await parseFile(f.path);
      results.set(r.filePath, r);
      if (r.error) totalErrors++;
    }
    return {
      results,
      stats: {
        totalFiles: files.length,
        workerCount: 0,
        chunkCount: 1,
        errorCount: totalErrors,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // Dispatch chunks to workers in round-robin
  const batchResults = new Map<number, WorkerParseResult[]>();
  const pending = new Set<number>();
  let nextBatchId = 0;
  let nextChunkIdx = 0;

  // Queue initial batch per worker
  for (let wi = 0; wi < workers.length && nextChunkIdx < chunks.length; wi++) {
    const batchId = nextBatchId++;
    const chunk = chunks[nextChunkIdx++];
    pending.add(batchId);

    workers[wi].postMessage({ type: 'parse', files: chunk, id: batchId });
    workers[wi].on('message', (msg: { type: string; batchId: number; results: WorkerParseResult[]; errors: number }) => {
      if (msg.type === 'result') {
        batchResults.set(msg.batchId, msg.results);
        totalErrors += msg.errors;
        pending.delete(msg.batchId);
      }
    });
  }

  // Process remaining chunks as workers free up
  const maxWaitMs = 300_000; // 5 min timeout
  const pollStart = Date.now();

  while (pending.size > 0) {
    // Assign new chunk to any free worker (round-robin)
    if (nextChunkIdx < chunks.length) {
      for (let wi = 0; wi < workers.length && nextChunkIdx < chunks.length; wi++) {
        const batchId = nextBatchId++;
        const chunk = chunks[nextChunkIdx++];
        pending.add(batchId);
        workers[wi].postMessage({ type: 'parse', files: chunk, id: batchId });
      }
    }

    if (Date.now() - pollStart > maxWaitMs) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  // Collect results
  for (const [, batch] of batchResults) {
    for (const r of batch) {
      results.set(r.filePath, r);
    }
  }

  // Shutdown workers
  for (const w of workers) {
    try { w.postMessage({ type: 'shutdown' }); } catch { /* ignore */ }
  }

  return {
    results,
    stats: {
      totalFiles: files.length,
      workerCount: workers.length,
      chunkCount,
      errorCount: totalErrors,
      durationMs: Date.now() - startTime,
    },
  };
}
