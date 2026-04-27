/**
 * BM25 full-text search via SQLite FTS5.
 *
 * Indexes graph node content (names, file paths, keywords) into an FTS5
 * virtual table for fast ranked retrieval using the BM25 algorithm.
 */

import Database from 'better-sqlite3';
import type { SqliteStore } from '../persist/sqlite.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  nodeId: string;
  label: string;
  name: string;
  filePath: string;
  /** BM25 relevance score (higher = more relevant). */
  score: number;
  /** Surrounding text snippet with match highlighted. */
  snippet: string;
}

// ── FTS5 schema ─────────────────────────────────────────────────────────────

const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_nodes USING fts5(
    node_id,
    label,
    name,
    filePath,
    keywords,
    tokenize='porter unicode61'
  );
`;

// ── Prepared statements ─────────────────────────────────────────────────────

function prepare(db: Database.Database) {
  return {
    search: db.prepare(`
      SELECT
        node_id AS nodeId,
        label,
        name,
        filePath,
        rank AS score,
        snippet(fts_nodes, 2, '<b>', '</b>', '...', 40) AS snippet
      FROM fts_nodes
      WHERE fts_nodes MATCH ?
      ORDER BY rank
      LIMIT ?
    `),
    insert: db.prepare(`
      INSERT OR REPLACE INTO fts_nodes (node_id, label, name, filePath, keywords)
      VALUES (?, ?, ?, ?, ?)
    `),
    deleteById: db.prepare(`
      DELETE FROM fts_nodes WHERE node_id = ?
    `),
    clear: db.prepare(`DELETE FROM fts_nodes`),
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface FtsSearch {
  /** Index the full graph content into the FTS table. */
  indexGraph(store: SqliteStore): void;

  /** Search for nodes matching the query string. */
  search(query: string, limit?: number): SearchResult[];

  /** Index a single node (for incremental updates). */
  indexNode(nodeId: string, label: string, name: string, filePath: string, keywords?: string[]): void;

  /** Remove a node from the FTS index. */
  deindexNode(nodeId: string): void;

  /** Close the database connection. */
  close(): void;
}

/**
 * Create an FTS5 search index backed by the same SQLite database
 * used by the persistence layer.
 */
export function createFtsSearch(dbPath: string): FtsSearch {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(FTS_SCHEMA);

  const stmts = prepare(db);

  return {
    indexGraph(store: SqliteStore): void {
      const graph = store.loadGraph();
      const clearTx = db.transaction(() => {
        stmts.clear.run();
      });
      clearTx();

      const indexTx = db.transaction(() => {
        for (const node of graph.iterNodes()) {
          if (!node.properties.name) continue;
          const keywords = (node.properties.keywords as string[])?.join(' ') ?? '';
          stmts.insert.run(
            node.id,
            node.label,
            node.properties.name ?? '',
            node.properties.filePath ?? '',
            keywords,
          );
        }
      });
      indexTx();
    },

    search(query: string, limit = 20): SearchResult[] {
      // Sanitize query for FTS5 (remove special chars)
      const sanitized = query.replace(/['"*()^~!]/g, ' ').trim();
      if (!sanitized) return [];
      // FTS5 prefix search
      const ftsQuery = sanitized.split(/\s+/).map((t) => `"${t}"*`).join(' AND ');

      try {
        return stmts.search.all(ftsQuery, limit) as SearchResult[];
      } catch {
        // Graceful fallback for bad queries
        return [];
      }
    },

    indexNode(nodeId: string, label: string, name: string, filePath: string, keywords?: string[]): void {
      stmts.insert.run(nodeId, label, name, filePath, (keywords ?? []).join(' '));
    },

    deindexNode(nodeId: string): void {
      stmts.deleteById.run(nodeId);
    },

    close(): void {
      db.close();
    },
  };
}
