/**
 * SQLite persistence layer for the Astrolabe knowledge graph.
 *
 * Provides save/load with prepared-statement batch inserts inside a
 * transaction, WAL mode for concurrent reads, and file-hash tracking
 * for incremental re-indexing.
 */

import Database from 'better-sqlite3';
import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../core/types.js';
import { createKnowledgeGraph } from '../core/graph.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SqliteStore {
  /** Persist the entire graph to SQLite (transaction-wrapped batch insert). */
  saveGraph(graph: KnowledgeGraph): void;

  /** Reconstruct the full KnowledgeGraph from SQLite. */
  loadGraph(): KnowledgeGraph;

  /** Store or update a file's content hash for incremental indexing. */
  saveFileHash(filePath: string, hash: string): void;

  /** Retrieve the last-known hash for a file, or undefined. */
  getFileHash(filePath: string): string | undefined;

  /** Return only files whose hash differs from the stored version (or new files). */
  getChangedFiles(files: { path: string; hash: string }[]): { path: string; hash: string }[];

  /** Quick count of persisted nodes. */
  getNodeCount(): number;

  /** Quick count of persisted relationships. */
  getRelationshipCount(): number;

  /** Close the database connection. */
  close(): void;
}

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    properties TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    reason TEXT NOT NULL DEFAULT '',
    step INTEGER,
    evidence TEXT
  );

  CREATE TABLE IF NOT EXISTS file_hashes (
    path TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    indexed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_id);
  CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id);
  CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(type);
`;

// ── Implementation ──────────────────────────────────────────────────────────

export function createSqliteStore(dbPath: string): SqliteStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // ── Prepared statements ───────────────────────────────────────────────
  const insertNode = db.prepare(
    'INSERT OR REPLACE INTO nodes (id, label, properties) VALUES (?, ?, ?)',
  );
  const insertRel = db.prepare(
    'INSERT OR REPLACE INTO relationships (id, source_id, target_id, type, confidence, reason, step, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const clearNodes = db.prepare('DELETE FROM nodes');
  const clearRels = db.prepare('DELETE FROM relationships');
  const upsertHash = db.prepare(
    'INSERT OR REPLACE INTO file_hashes (path, hash, indexed_at) VALUES (?, ?, ?)',
  );
  const getHash = db.prepare('SELECT hash FROM file_hashes WHERE path = ?');
  const countNodes = db.prepare('SELECT COUNT(*) as cnt FROM nodes');
  const countRels = db.prepare('SELECT COUNT(*) as cnt FROM relationships');
  const allNodes = db.prepare('SELECT id, label, properties FROM nodes');
  const allRels = db.prepare(
    'SELECT id, source_id, target_id, type, confidence, reason, step, evidence FROM relationships',
  );

  // ── Public API ─────────────────────────────────────────────────────────

  return {
    saveGraph(graph: KnowledgeGraph): void {
      const saveTx = db.transaction(() => {
        clearNodes.run();
        clearRels.run();

        for (const node of graph.nodes) {
          insertNode.run(node.id, node.label, JSON.stringify(node.properties));
        }

        for (const rel of graph.relationships) {
          insertRel.run(
            rel.id,
            rel.sourceId,
            rel.targetId,
            rel.type,
            rel.confidence,
            rel.reason,
            rel.step ?? null,
            rel.evidence ? JSON.stringify(rel.evidence) : null,
          );
        }
      });

      saveTx();
    },

    loadGraph(): KnowledgeGraph {
      const graph = createKnowledgeGraph();

      const nodeRows = allNodes.all() as {
        id: string; label: string; properties: string;
      }[];
      for (const row of nodeRows) {
        graph.addNode({
          id: row.id,
          label: row.label as GraphNode['label'],
          properties: JSON.parse(row.properties),
        });
      }

      const relRows = allRels.all() as {
        id: string; source_id: string; target_id: string; type: string;
        confidence: number; reason: string; step: number | null; evidence: string | null;
      }[];
      for (const row of relRows) {
        graph.addRelationship({
          id: row.id,
          sourceId: row.source_id,
          targetId: row.target_id,
          type: row.type as GraphRelationship['type'],
          confidence: row.confidence,
          reason: row.reason,
          ...(row.step != null ? { step: row.step } : {}),
          ...(row.evidence ? { evidence: JSON.parse(row.evidence) } : {}),
        });
      }

      return graph;
    },

    saveFileHash(filePath: string, hash: string): void {
      upsertHash.run(filePath, hash, Date.now());
    },

    getFileHash(filePath: string): string | undefined {
      const row = getHash.get(filePath) as { hash: string } | undefined;
      return row?.hash;
    },

    getChangedFiles(files: { path: string; hash: string }[]): { path: string; hash: string }[] {
      return files.filter((f) => {
        const stored = this.getFileHash(f.path);
        return !stored || stored !== f.hash;
      });
    },

    getNodeCount(): number {
      const row = countNodes.get() as { cnt: number };
      return row.cnt;
    },

    getRelationshipCount(): number {
      const row = countRels.get() as { cnt: number };
      return row.cnt;
    },

    close(): void {
      db.close();
    },
  };
}
