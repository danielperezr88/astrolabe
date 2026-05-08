/**
 * BM25 full-text search via SQLite FTS5.
 *
 * Indexes graph node content (names, file paths, keywords) into an FTS5
 * virtual table for fast ranked retrieval using the BM25 algorithm.
 */

import '../persist/native-preload.js'; // #224: triggers electron binary copy before better-sqlite3 loads
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

// ── Lazy index check ────────────────────────────────────────────────────────

const FTS_EXISTS = `
  SELECT name FROM sqlite_master
  WHERE type='table' AND name='fts_nodes'
`;

const POPULATE_FROM_NODES = `
  SELECT id, label, properties FROM nodes
  WHERE json_extract(properties, '$.name') IS NOT NULL
`;

const NODES_EXIST = `
  SELECT name FROM sqlite_master
  WHERE type='table' AND name='nodes'
`;

// ── Prepared statements ─────────────────────────────────────────────────────

function prepareStatements(db: Database.Database) {
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
 * Create an FTS5 search index with lazy initialization.
 *
 * The FTS5 virtual table is NOT created until the first operation that
 * needs it (search, indexNode, etc.). This avoids the cost of building
 * the full-text index for repos that are analyzed but never queried.
 *
 * Accepts either a Database instance (to share the connection with the
 * persistence layer) or a file path (creates a new connection).
 */
export function createFtsSearch(dbOrPath: Database.Database | string, _store?: SqliteStore): FtsSearch {
  const db = typeof dbOrPath === 'string' ? new Database(dbOrPath) : dbOrPath;
  const ownsConnection = typeof dbOrPath === 'string';
  if (ownsConnection) {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  }
  // Don't set journal_mode on a shared connection — the owner controls it.

  let indexCreated = false;
  let stmts: ReturnType<typeof prepareStatements> | null = null;

  /** Populate FTS from the `nodes` table already present in the database. */
  function populateFromNodesTable(): void {
    const hasNodes = db.prepare(NODES_EXIST).get();
    if (!hasNodes) return;
    const rows = db.prepare(POPULATE_FROM_NODES)
      .all() as Array<{ id: string; label: string; properties: string }>;
    if (rows.length === 0) return;
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO fts_nodes (node_id, label, name, filePath, keywords)
      VALUES (?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const row of rows) {
        const props = JSON.parse(row.properties);
        const keywords = Array.isArray(props.keywords)
          ? (props.keywords as string[]).join(' ')
          : (props.keywords as string | undefined) ?? '';
        insertStmt.run(
          row.id,
          row.label,
          props.name ?? '',
          props.filePath ?? '',
          keywords,
        );
      }
    });
    tx();
  }

  /**
   * Ensure the FTS5 virtual table exists before any read/write operation.
   *
   * - First call checks `sqlite_master` and creates the table if absent,
   *   populating it from any pre-existing node data.
   * - Subsequent calls are a no-op thanks to the in-process flag.
   */
  function ensureIndex(): void {
    if (indexCreated) return;

    const exists = db.prepare(FTS_EXISTS).get();
    if (!exists) {
      db.exec(FTS_SCHEMA);
      populateFromNodesTable();
    }

    stmts = prepareStatements(db);
    indexCreated = true;
  }

  return {
    indexGraph(store: SqliteStore): void {
      ensureIndex();
      const graph = store.loadGraph();
      // Combine clear + reindex into a single transaction to avoid a window
      // where concurrent searches return zero results.
      const tx = db.transaction(() => {
        stmts!.clear.run();
        for (const node of graph.iterNodes()) {
          if (!node.properties.name) continue;
          const keywords = (node.properties.keywords as string[])?.join(' ') ?? '';
          stmts!.insert.run(
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
      ensureIndex();
      // Sanitize query for FTS5 (remove special chars, keep alphanumeric + underscore)
      // #310: Also escape { } : which are FTS5 special chars
      const sanitized = query.replace(/['"*()^~!@#$%&=+<>|{}:]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!sanitized) return [];
      // Use AND between terms so multi-word queries require all terms to match.
      // Single-word queries use prefix matching for partial completion.
      const terms = sanitized.split(/\s+/).filter((t) => t.length > 0);
      const ftsQuery = terms.map((t) => `"${t}"*`).join(' AND ');

      try {
        return stmts!.search.all(ftsQuery, limit) as SearchResult[];
      } catch {
        // Graceful fallback for bad queries
        return [];
      }
    },

    indexNode(nodeId: string, label: string, name: string, filePath: string, keywords?: string[]): void {
      ensureIndex();
      stmts!.insert.run(nodeId, label, name, filePath, (keywords ?? []).join(' '));
    },

    deindexNode(nodeId: string): void {
      ensureIndex();
      stmts!.deleteById.run(nodeId);
    },

    close(): void {
      // #285: Only close if we own the connection — shared DB is caller's responsibility
      if (ownsConnection) db.close();
    },
  };
}
