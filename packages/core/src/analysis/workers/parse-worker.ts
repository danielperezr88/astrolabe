/**
 * Parse Worker — worker thread for parallel file parsing (#272).
 *
 * Each worker runs in its own thread, loads tree-sitter WASM grammars
 * independently, parses assigned files, and returns results via the
 * parent message channel.
 */

import { parentPort } from 'node:worker_threads';
import { initParser, parseFile, defaultWasmDir } from '../parser.js';

// ── State ──────────────────────────────────────────────────────────────────

let initialized = false;

// ── Message handler ────────────────────────────────────────────────────────

parentPort?.on('message', async (msg: { type: string; files?: string[]; id?: number }) => {
  if (msg.type === 'parse') {
    await handleParse(msg.files ?? [], msg.id ?? 0);
  } else if (msg.type === 'shutdown') {
    process.exit(0);
  }
});

// ── Parse handling ─────────────────────────────────────────────────────────

async function handleParse(files: string[], batchId: number): Promise<void> {
  try {
    if (!initialized) {
      await initParser();
      initialized = true;
    }

    const wasmDir = defaultWasmDir();
    const results = [];
    let errors = 0;

    for (const filePath of files) {
      try {
        const result = await parseFile(filePath, wasmDir);
        // Convert error to serializable form
        if (result.error) {
          results.push({ filePath, symbols: [], imports: [], relationships: [], error: result.error });
          errors++;
        } else {
          // Strip non-serializable parts (like tree-sitter tree references)
          results.push({
            filePath,
            symbols: result.symbols.map((s) => ({ ...s })),
            imports: result.imports.map((i) => ({
              id: i.id, source: i.source, names: i.names, startLine: i.startLine,
            })),
            relationships: result.relationships.map((r) => ({
              sourceName: r.sourceName, sourceStartLine: r.sourceStartLine,
              targetName: r.targetName, type: r.type,
            })),
          });
        }
      } catch (err) {
        results.push({
          filePath,
          symbols: [],
          imports: [],
          relationships: [],
          error: err instanceof Error ? err.message : String(err),
        });
        errors++;
      }
    }

    parentPort?.postMessage({ type: 'result', batchId, results, errors });
  } catch (err) {
    parentPort?.postMessage({
      type: 'result',
      batchId,
      results: [],
      errors: files.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
