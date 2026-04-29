/**
 * Embedding Store — SQLite-based vector storage for semantic search (#261).
 *
 * Stores float32 embedding vectors in a dedicated SQLite table alongside
 * the knowledge graph. Supports caching by SHA1 content hash for
 * incremental updates.
 *
 * The embedding provider is abstracted — currently uses TF-IDF vector
 * densification, swappable for ML models later.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { TfIdfIndex } from './embeddings.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface EmbeddingEntry {
  /** Graph node ID (same as in nodes table). */
  nodeId: string;
  /** SHA1 of the content that was encoded. */
  contentHash: string;
  /** Float32 embedding vector as a Buffer. */
  vector: Buffer;
  /** Vector dimensionality. */
  dimensions: number;
  /** When this embedding was computed (epoch ms). */
  indexedAt: number;
}

export interface EmbeddingProvider {
  /** Compute a float32 embedding for a text string. */
  encode(text: string): Float32Array;
  /** Dimensionality of the embeddings produced. */
  dimensions: number;
}

// ── TF-IDF dense embedding provider ────────────────────────────────────────

/**
 * Creates an embedding provider that converts TF-IDF sparse vectors
 * into dense float32 embeddings by projecting onto the vocabulary space.
 *
 * This is a lightweight fallback — swap for an ML model (e.g. transformers.js)
 * by providing a different EmbeddingProvider implementation.
 */
export function createTfIdfEmbeddingProvider(index: TfIdfIndex): EmbeddingProvider {
  // Build vocabulary from the index
  const vocab = new Map<string, number>();
  let nextIdx = 0;
  for (const [, vec] of index.vectors) {
    for (const term of vec.weights.keys()) {
      if (!vocab.has(term)) {
        vocab.set(term, nextIdx++);
      }
    }
  }
  const dims = vocab.size || 384; // fallback dimensionality

  return {
    dimensions: dims,
    encode(text: string): Float32Array {
      // Simple bag-of-words projection — each dimension is 1.0 if the term
      // appears in the text, 0.0 otherwise
      const vec = new Float32Array(dims);
      const tokens = new Set(
        text
          .toLowerCase()
          .replace(/[^a-z0-9\s_-]/g, ' ')
          .split(/\s+/)
          .filter((t) => t.length > 1),
      );
      for (const t of tokens) {
        const idx = vocab.get(t);
        if (idx !== undefined) vec[idx] = 1.0;
      }
      return vec;
    },
  };
}

// ── Transformers.js embedding provider ─────────────────────────────────────

/** Default model: snowflake-arctic-embed-xs (384D, lightweight). */
const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_LOCAL_DIMS = 384;

/**
 * ML-powered embedding provider using @huggingface/transformers (transformers.js).
 *
 * Runs locally — no network calls after initial model download.
 * Uses the feature-extraction pipeline with mean pooling.
 *
 * Model selection:
 *   Xenova/all-MiniLM-L6-v2 (384D) — fast, small, good for code
 *   Snowflake/snowflake-arctic-embed-xs (384D) — optimized for retrieval
 *
 * Configure via env:
 *   ASTROLABE_EMBEDDING_MODEL=all-MiniLM-L6-v2  (model name, Xenova/ prefix auto-added)
 *   ASTROLABE_EMBEDDING_DIMS=384
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  public readonly dimensions: number;
  private _pipeline: unknown = null;
  private _modelName: string;
  private _ready = false;
  private _initPromise: Promise<void> | null = null;

  constructor(dimensions = DEFAULT_LOCAL_DIMS) {
    this.dimensions = dimensions;
    this._modelName = process.env.ASTROLABE_EMBEDDING_MODEL ?
      (process.env.ASTROLABE_EMBEDDING_MODEL.includes('/') ?
        process.env.ASTROLABE_EMBEDDING_MODEL :
        `Xenova/${process.env.ASTROLABE_EMBEDDING_MODEL}`) :
      DEFAULT_LOCAL_MODEL;
    if (process.env.ASTROLABE_EMBEDDING_DIMS) {
      this.dimensions = parseInt(process.env.ASTROLABE_EMBEDDING_DIMS, 10) || DEFAULT_LOCAL_DIMS;
    }
  }

  /**
   * Ensure the transformers pipeline is initialized.
   * Lazy-loaded — no model download until first encode() call.
   */
  async ensureReady(): Promise<void> {
    if (this._ready) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._init();
    return this._initPromise;
  }

  private async _init(): Promise<void> {
    try {
      const { pipeline } = await import('@huggingface/transformers');
      this._pipeline = await pipeline('feature-extraction', this._modelName, {
        // Use ONNX runtime for performance if available
        // quantized: true reduces model size but may lose accuracy
      });
      this._ready = true;
    } catch (err) {
      throw new Error(
        `Failed to load transformers model "${this._modelName}": ${(err as Error).message}. ` +
        `Install with: npm install @huggingface/transformers`,
      );
    }
  }

  /**
   * Encode text to a Float32Array embedding using the ML model.
   * Mean-pooling over token embeddings produces a fixed-size vector.
   */
  encode(_text: string): Float32Array {
    // Synchronous encode returns zeros — callers should use encodeAsync
    // for ML-powered embeddings. This is the sync path for the EmbeddingProvider
    // interface compatibility; encodeAsync provides the real ML embeddings.
    const vec = new Float32Array(this.dimensions);
    return vec;
  }

  /**
   * Async encode using the transformers pipeline.
   * Returns a dense Float32Array embedding for the input text.
   */
  async encodeAsync(text: string): Promise<Float32Array> {
    await this.ensureReady();

    const pipe = this._pipeline as any;
    if (!pipe) {
      // Fallback: bag-of-words in the dimensions space
      const vec = new Float32Array(this.dimensions);
      const tokens = text.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/).filter(t => t.length > 1);
      for (const t of tokens) {
        const idx = hashStr(t) % this.dimensions;
        vec[idx] += 1.0;
      }
      // Normalize
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
      return vec;
    }

    const output = await pipe(text, { pooling: 'mean', normalize: true });
    // output is a Tensor-like object with data property
    const tensor = output as { data: Float32Array | number[]; dims?: number[] };
    if (tensor.data instanceof Float32Array) {
      return tensor.data;
    }
    return new Float32Array(Array.from(tensor.data));
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ── Remote embedding provider (OpenAI-compatible) ──────────────────────────

/**
 * Embedding provider that calls a remote OpenAI-compatible /v1/embeddings endpoint.
 *
 * Works with: OpenAI, Ollama, vLLM, Infinity, TEI, llama.cpp, LM Studio, etc.
 *
 * Configure via env:
 *   ASTROLABE_EMBEDDING_URL=http://localhost:11434/v1    (required)
 *   ASTROLABE_EMBEDDING_MODEL=nomic-embed-text            (model name sent to API)
 *   ASTROLABE_EMBEDDING_DIMS=768                          (optional, auto-detected)
 *   ASTROLABE_EMBEDDING_API_KEY=sk-...                    (optional)
 */
export class RemoteEmbeddingProvider implements EmbeddingProvider {
  public readonly dimensions: number;
  private _url: string;
  private _model: string;
  private _apiKey: string | undefined;

  constructor() {
    const url = process.env.ASTROLABE_EMBEDDING_URL;
    if (!url) {
      throw new Error(
        'ASTROLABE_EMBEDDING_URL must be set to use remote embeddings. ' +
        'Example: http://localhost:11434/v1 for Ollama',
      );
    }
    this._url = url.replace(/\/+$/, '') + '/embeddings';
    const rawModel = process.env.ASTROLABE_EMBEDDING_MODEL;
    this._model = (rawModel && rawModel !== 'undefined') ? rawModel : 'nomic-embed-text';
    this._apiKey = process.env.ASTROLABE_EMBEDDING_API_KEY;
    const dimsVal = process.env.ASTROLABE_EMBEDDING_DIMS ?
      parseInt(process.env.ASTROLABE_EMBEDDING_DIMS, 10) :
      768;
    this.dimensions = Number.isNaN(dimsVal) ? 768 : dimsVal;
  }

  /**
   * Encode text to a Float32Array embedding via remote API.
   * Synchronous version returns empty — use encodeAsync.
   */
  encode(_text: string): Float32Array {
    return new Float32Array(this.dimensions);
  }

  /**
   * Async encode via remote API with retry logic.
   */
  async encodeAsync(text: string): Promise<Float32Array> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this._apiKey && this._apiKey !== 'unused') {
      headers['Authorization'] = `Bearer ${this._apiKey}`;
    }

    const body = JSON.stringify({
      input: text,
      model: this._model,
    });

    // Retry up to 3 times with exponential backoff
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(this._url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(30000),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => 'unknown error');
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }

        const json = (await res.json()) as {
          data: Array<{ embedding: number[] }>;
        };

        if (!json.data?.[0]?.embedding) {
          throw new Error('Invalid response: missing data[0].embedding');
        }

        const emb = json.data[0].embedding;
        // Auto-detect dimensions from first successful response
        if (emb.length !== this.dimensions) {
          (this as { dimensions: number }).dimensions = emb.length;
        }

        return new Float32Array(emb);
      } catch (err) {
        if (attempt === 2) throw err;
        // Wait with exponential backoff: 1s, 2s
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }

    throw new Error('Unreachable');
  }
}

// ── Provider factory ───────────────────────────────────────────────────────

export type EmbeddingProviderType = 'tfidf' | 'transformers' | 'remote' | 'auto';

/**
 * Create an embedding provider based on environment configuration.
 *
 * Priority:
 *   1. ASTROLABE_EMBEDDING_URL set → RemoteEmbeddingProvider
 *   2. ASTROLABE_PROVIDER=transformers → TransformersEmbeddingProvider
 *   3. ASTROLABE_PROVIDER=remote → RemoteEmbeddingProvider (requires URL)
 *   4. ASTROLABE_PROVIDER=tfidf → TF-IDF fallback
 *   5. auto (default) → try remote first, then transformers, then TF-IDF
 *
 * @param tfidfIndex  Optional TF-IDF index for the fallback provider.
 */
export function createEmbeddingProvider(
  providerType: EmbeddingProviderType = 'auto',
  tfidfIndex?: TfIdfIndex,
): EmbeddingProvider {
  // Explicit remote
  if (providerType === 'remote' || (providerType === 'auto' && process.env.ASTROLABE_EMBEDDING_URL)) {
    try {
      return new RemoteEmbeddingProvider();
    } catch (err) {
      if (providerType === 'remote') throw err;
      // auto mode: fall through to next provider
    }
  }

  // Explicit transformers
  if (providerType === 'transformers') {
    return new TransformersEmbeddingProvider();
  }

  // Auto: try transformers (won't download model until encodeAsync called)
  if (providerType === 'auto') {
    try {
      // Check if transformers is importable without downloading model
      return new TransformersEmbeddingProvider();
    } catch {
      // Fall through to TF-IDF
    }
  }

  // TF-IDF fallback
  if (tfidfIndex) {
    return createTfIdfEmbeddingProvider(tfidfIndex);
  }

  // Absolute fallback: dummy 384D provider
  return {
    dimensions: 384,
    encode(_text: string): Float32Array {
      return new Float32Array(384);
    },
  };
}

/**
 * Check whether @huggingface/transformers is available (installed).
 * Does NOT download the model — just checks if the package can be imported.
 */
export async function isTransformersAvailable(): Promise<boolean> {
  try {
    await import('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

// ── SQLite embedding store ─────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS embeddings (
    node_id   TEXT PRIMARY KEY,
    hash      TEXT NOT NULL,
    vector    BLOB NOT NULL,
    dims      INTEGER NOT NULL DEFAULT 384,
    indexed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings(hash);
`;

export class EmbeddingStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private getStmt: Database.Statement;
  private getAllStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    db.exec(SCHEMA);
    this.insertStmt = db.prepare(
      'INSERT OR REPLACE INTO embeddings (node_id, hash, vector, dims, indexed_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.getStmt = db.prepare('SELECT * FROM embeddings WHERE node_id = ?');
    this.getAllStmt = db.prepare('SELECT * FROM embeddings');
  }

  /**
   * Compute content hash for a node — used for cache invalidation.
   */
  static contentHash(node: { properties: Record<string, unknown> }): string {
    const name = (node.properties.name as string) ?? '';
    const label = (node.properties.label as string) ?? (node as any).label ?? '';
    return createHash('sha1').update(`${label}:${name}`).digest('hex');
  }

  /**
   * Store an embedding vector for a node.
   */
  upsert(nodeId: string, contentHash: string, vector: Float32Array): void {
    this.insertStmt.run(nodeId, contentHash, Buffer.from(vector.buffer), vector.length, Date.now());
  }

  /**
   * Get a single embedding by node ID. Returns null if not found.
   */
  get(nodeId: string): EmbeddingEntry | null {
    const row = this.getStmt.get(nodeId) as any;
    if (!row) return null;
    return {
      nodeId: row.node_id,
      contentHash: row.hash,
      vector: row.vector as Buffer,
      dimensions: row.dims,
      indexedAt: row.indexed_at,
    };
  }

  /**
   * Get all embeddings for vector search.
   */
  getAll(): EmbeddingEntry[] {
    const rows = this.getAllStmt.all() as any[];
    return rows.map((row: any) => ({
      nodeId: row.node_id,
      contentHash: row.hash,
      vector: row.vector as Buffer,
      dimensions: row.dims,
      indexedAt: row.indexed_at,
    }));
  }

  /**
   * Compute or retrieve cached embedding for a node.
   */
  getOrCompute(
    node: { id: string; properties: Record<string, unknown> },
    provider: EmbeddingProvider,
  ): Float32Array {
    const hash = EmbeddingStore.contentHash(node);
    const cached = this.get(node.id);
    if (cached && cached.contentHash === hash) {
      return new Float32Array(cached.vector.buffer);
    }

    const name = (node.properties.name as string) ?? node.id;
    const text = `${node.properties.label ?? (node as any).label ?? ''} ${name}`;
    const vec = provider.encode(text);
    this.upsert(node.id, hash, vec);
    return vec;
  }

  close(): void {
    // Statements are automatically finalized when DB closes
  }
}
