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
