/**
 * BM25 full-text search via SQLite FTS5.
 *
 * Indexes graph node content (names, file paths, keywords) into an FTS5
 * virtual table for fast ranked retrieval using the BM25 algorithm.
 */

import '../persist/native-preload.js'; // must be first — swaps binary for Electron
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
 * Create an FTS5 search index.
 *
 * Accepts either a Database instance (to share the connection with the
 * persistence layer) or a file path (creates a new connection).
 */
export function createFtsSearch(dbOrPath: Database.Database | string, _store?: SqliteStore): FtsSearch {
  const db = typeof dbOrPath === 'string' ? new Database(dbOrPath) : dbOrPath;
  const ownsConnection = typeof dbOrPath === 'string';
  if (ownsConnection) {
    db.pragma('journal_mode = WAL');
  }
  // Don't set journal_mode on a shared connection — the owner controls it.
  db.exec(FTS_SCHEMA);

  const stmts = prepare(db);

  return {
    indexGraph(store: SqliteStore): void {
      const graph = store.loadGraph();
      // Combine clear + reindex into a single transaction to avoid a window
      // where concurrent searches return zero results.
      const tx = db.transaction(() => {
        stmts.clear.run();
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
      tx();
    },

    search(query: string, limit = 20): SearchResult[] {
      // Sanitize query for FTS5 (remove special chars, keep alphanumeric + underscore)
      const sanitized = query.replace(/['"*()^~!@#$%&=+<>|]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!sanitized) return [];
      // Use AND between terms so multi-word queries require all terms to match.
      // Single-word queries use prefix matching for partial completion.
      const terms = sanitized.split(/\s+/).filter((t) => t.length > 0);
      const ftsQuery = terms.map((t) => `"${t}"*`).join(' AND ');

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
