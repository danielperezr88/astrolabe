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
import { createLogger } from '../../logging/index.js';

const log = createLogger({ level: 'debug' });

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
  /** #860: Call sites extracted for CALLS edge emission. */
  callSites?: Array<{
    name: string; form: string; receiver?: string;
    argCount: number; filePath: string; startLine: number;
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
  // Try compiled path (production)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const prodPath = join(__dirname, 'parse-worker.js');
  if (existsSync(prodPath)) return prodPath;

  // #319: Do NOT return .ts source path — Node.js worker_threads cannot
  // execute TypeScript directly. If .js doesn't exist, fall back to sequential.
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

  // #315-317, #320: Event-driven dispatch — Promise per chunk, no busy-wait polling
  const chunkResults = new Map<number, WorkerParseResult[]>();
  // #477: Track which batch was dispatched to which worker
  const batchToWorker = new Map<number, number>();
  const workerBusy = new Array(workers.length).fill(false);
  let nextBatchId = 0;
  let nextChunkIdx = 0;
  let activeBatches = 0;

  // Resolve when all chunks are processed or timed out
  const maxWaitMs = 300_000; // 5 min timeout
  let resolveAll: (() => void) | null = null;
  const allDone = new Promise<void>((resolve) => { resolveAll = resolve; });
  const timeout = setTimeout(() => resolveAll?.(), maxWaitMs);

  function dispatchChunk(worker: Worker, wi: number): void {
    if (nextChunkIdx >= chunks.length) return;
    const batchId = nextBatchId++;
    const chunk = chunks[nextChunkIdx++];
    activeBatches++;
    workerBusy[wi] = true;

    worker.postMessage({ type: 'parse', files: chunk, id: batchId });
    batchToWorker.set(batchId, wi); // #477: track assignment

    // #316: Use once() to prevent listener stacking
    const onResult = (msg: { type: string; batchId: number; results: WorkerParseResult[]; errors: number }) => {
      if (msg.type === 'result' && msg.batchId === batchId) {
        chunkResults.set(msg.batchId, msg.results);
        totalErrors += msg.errors;
        activeBatches--;
        workerBusy[wi] = false;
        worker.removeListener('message', onResult);

        // #315: Dispatch next chunk to this now-free worker
        if (nextChunkIdx < chunks.length) {
          dispatchChunk(worker, wi);
        } else if (activeBatches === 0) {
          resolveAll?.();
        }
      }
    };

    worker.on('message', onResult);
  }

  // #320: Error/exit handlers with sequential fallback
  const workerFailedChunks: string[][] = [];

  for (let wi = 0; wi < workers.length; wi++) {
    workers[wi].on('error', (err) => {
      console.warn(`[worker-pool] Worker ${wi} error: ${String(err)}`);
    });

    workers[wi].on('exit', (code) => {
      if (code !== 0 && workerBusy[wi]) {
        // Worker crashed mid-parse — collect its pending chunks for fallback
        console.warn(`[worker-pool] Worker ${wi} exited with code ${code}, falling back to sequential`);
        // #477: Use batchToWorker tracking instead of broken round-robin assumption
        for (const [batchId, workerIdx] of batchToWorker) {
          if (workerIdx === wi && !chunkResults.has(batchId)) {
            const chunk = chunks[batchId];
            if (chunk) workerFailedChunks.push(chunk);
          }
        }
      }
    });

    // #315: Initial dispatch — one chunk per worker
    if (nextChunkIdx < chunks.length) {
      dispatchChunk(workers[wi], wi);
    }
  }

  // Wait for all chunks to complete or timeout
  await allDone;
  clearTimeout(timeout);

  // #320: Sequential fallback for failed chunks
  for (const failedChunk of workerFailedChunks) {
    for (const filePath of failedChunk) {
      try {
        const r = await parseFile(filePath);
        results.set(r.filePath, r);
        if (r.error) totalErrors++;
      } catch {
        totalErrors++;
      }
    }
  }

  // Collect results
  for (const [, batch] of chunkResults) {
    for (const r of batch) {
      results.set(r.filePath, r);
    }
  }

  // Shutdown workers
  for (const w of workers) {
    try { w.postMessage({ type: 'shutdown' }); } catch (err) { log.debug('Worker shutdown message failed', { error: String(err) }); }
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
