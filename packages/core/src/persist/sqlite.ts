/**
 * SQLite persistence layer for the Astrolabe knowledge graph.
 *
 * Provides save/load with prepared-statement batch inserts inside a
 * transaction, WAL mode for concurrent reads, and file-hash tracking
 * for incremental re-indexing.
 */

import './native-preload.js'; // #224: triggers electron binary copy before better-sqlite3 loads
import Database from 'better-sqlite3';
import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../core/types.js';
import { createKnowledgeGraph } from '../core/graph.js';
import { createLogger } from '../logging/index.js';
import type { SnapshotData, SnapshotDiff } from '../core/graph-evolution.js';

const log = createLogger({ level: 'debug' });

// ── DB Lock Retry Helpers ──────────────────────────────────────────────────

/**
 * Detect whether an error is an SQLITE_BUSY / "database is locked" error
 * thrown by better-sqlite3 when concurrent writers collide.
 */
export function isDbBusyError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    const code = (error as { code?: unknown }).code;
    return code === 'SQLITE_BUSY' || code === 5 || msg.includes('database is locked') || msg.includes('busy');
  }
  return false;
}

/**
 * Retry wrapper for **synchronous** database write operations.
 *
 * Retries up to `maxAttempts` times on SQLITE_BUSY errors with
 * exponential back-off (baseDelay × attempt number).
 *
 * Only logs retry attempts when `ASTROLABE_DEBUG` is set.
 */
export function withRetrySync<T>(fn: () => T, maxAttempts = 3, baseDelay = 100): T {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (!isDbBusyError(err) || attempt === maxAttempts) throw err;
      const delay = baseDelay * attempt;
      if (process.env.ASTROLABE_DEBUG) {
        console.error(`Astrolabe [db:retry] attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`);
      }
      // Synchronous sleep via Atomics.wait on a shared buffer
      const buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, delay);
    }
  }
  throw lastError;
}

/**
 * Async variant of the retry wrapper — uses real `setTimeout` so it
 * yields the event loop between attempts. Preferred in async contexts.
 */
export async function withRetry<T>(fn: () => T | Promise<T>, maxAttempts = 3, baseDelay = 100): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isDbBusyError(err) || attempt === maxAttempts) throw err;
      const delay = baseDelay * attempt;
      if (process.env.ASTROLABE_DEBUG) {
        console.error(`Astrolabe [db:retry] attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`);
      }
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

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

  /** Save a snapshot of graph metrics for temporal evolution tracking (#807). */
  saveSnapshot(data: SnapshotData): void;

  /** Load snapshots, optionally filtered by timestamp range. */
  loadSnapshots(since?: string, until?: string): SnapshotData[];

  /** Compute a diff between two snapshots by ID. */
  diffSnapshots(fromId: string, toId: string): SnapshotDiff | null;

  /** Close the database connection. */
  close(): void;
}

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
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

  CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    commit_sha TEXT NOT NULL DEFAULT 'unknown',
    branch TEXT NOT NULL DEFAULT 'unknown',
    node_count INTEGER NOT NULL DEFAULT 0,
    edge_count INTEGER NOT NULL DEFAULT 0,
    community_count INTEGER NOT NULL DEFAULT 0,
    modularity REAL NOT NULL DEFAULT 0,
    avg_pagerank_max REAL NOT NULL DEFAULT 0,
    avg_betweenness_max REAL NOT NULL DEFAULT 0,
    health_score REAL NOT NULL DEFAULT 0,
    cohesion REAL NOT NULL DEFAULT 0,
    complexity REAL NOT NULL DEFAULT 0,
    cycle_count INTEGER NOT NULL DEFAULT 0,
    hub_count INTEGER NOT NULL DEFAULT 0,
    unstable_dep_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp);
`;

export const CURRENT_SCHEMA_VERSION = 1;

// ── Implementation ──────────────────────────────────────────────────────────

export function createSqliteStore(dbPath: string): SqliteStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // Read existing schema version; apply migrations if behind (#158)
  const currentVer = db.pragma('user_version', { simple: true }) as number;
  if (currentVer < CURRENT_SCHEMA_VERSION) {
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  }

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

  // ── Snapshot prepared statements (#807) ───────────────────────────
  const insertSnapshot = db.prepare(
    `INSERT OR REPLACE INTO snapshots
       (id, timestamp, commit_sha, branch, node_count, edge_count, community_count,
        modularity, avg_pagerank_max, avg_betweenness_max, health_score,
        cohesion, complexity, cycle_count, hub_count, unstable_dep_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getSnapshots = db.prepare(
    'SELECT * FROM snapshots WHERE (? IS NULL OR timestamp >= ?) AND (? IS NULL OR timestamp <= ?) ORDER BY timestamp ASC',
  );
  const getSnapshotById = db.prepare('SELECT * FROM snapshots WHERE id = ?');

  // ── Snapshot row type ─────────────────────────────────────────────
  interface SnapshotRow {
    id: string; timestamp: string; commit_sha: string; branch: string;
    node_count: number; edge_count: number; community_count: number;
    modularity: number; avg_pagerank_max: number; avg_betweenness_max: number;
    health_score: number; cohesion: number; complexity: number;
    cycle_count: number; hub_count: number; unstable_dep_count: number;
  }

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

      withRetrySync(() => saveTx());
    },

    loadGraph(): KnowledgeGraph {
      const graph = createKnowledgeGraph();

      const nodeRows = allNodes.all() as {
        id: string; label: string; properties: string;
      }[];
      for (const row of nodeRows) {
        // #311: Graceful fallback for corrupted JSON properties
        let props: Record<string, unknown>;
        try { props = JSON.parse(row.properties); } catch (err) { log.debug('Corrupted node properties, using empty fallback', { nodeId: row.id, error: String(err) }); props = {}; }
        graph.addNode({
          id: row.id,
          label: row.label as GraphNode['label'],
          properties: props,
        });
      }

      const relRows = allRels.all() as {
        id: string; source_id: string; target_id: string; type: string;
        confidence: number; reason: string; step: number | null; evidence: string | null;
      }[];
      for (const row of relRows) {
        // #423: Graceful fallback for corrupted evidence JSON
        let evidence: readonly any[] | undefined;
        if (row.evidence) {
          try { evidence = JSON.parse(row.evidence); } catch (err) { log.debug('Skipping corrupted evidence JSON', { relId: row.id, error: String(err) }); }
        }
        graph.addRelationship({
          id: row.id,
          sourceId: row.source_id,
          targetId: row.target_id,
          type: row.type as GraphRelationship['type'],
          confidence: row.confidence,
          reason: row.reason,
          ...(row.step != null ? { step: row.step } : {}),
          ...(evidence ? { evidence } : {}),
        });
      }

      return graph;
    },

    saveFileHash(filePath: string, hash: string): void {
      withRetrySync(() => upsertHash.run(filePath, hash, Date.now()));
    },

    getFileHash(filePath: string): string | undefined {
      const row = getHash.get(filePath) as { hash: string } | undefined;
      return row?.hash;
    },

    getChangedFiles(files: { path: string; hash: string }[]): { path: string; hash: string }[] {
      // #286: Use closure variable getHash, not this.getFileHash (breaks on destructuring)
      return files.filter((f) => {
        const row = getHash.get(f.path) as { hash: string } | undefined;
        const stored = row?.hash;
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

    saveSnapshot(data: SnapshotData): void {
      withRetrySync(() => insertSnapshot.run(
        data.id, data.timestamp, data.commitSha, data.branch,
        data.nodeCount, data.edgeCount, data.communityCount,
        data.modularity, data.avgPagerankMax, data.avgBetweennessMax,
        data.healthScore, data.cohesion, data.complexity,
        data.cycleCount, data.hubCount, data.unstableDepCount,
      ));
    },

    loadSnapshots(since?: string, until?: string): SnapshotData[] {
      const rows = getSnapshots.all(since ?? null, since ?? null, until ?? null, until ?? null) as Array<{
        id: string; timestamp: string; commit_sha: string; branch: string;
        node_count: number; edge_count: number; community_count: number;
        modularity: number; avg_pagerank_max: number; avg_betweenness_max: number;
        health_score: number; cohesion: number; complexity: number;
        cycle_count: number; hub_count: number; unstable_dep_count: number;
      }>;
      return rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        commitSha: r.commit_sha,
        branch: r.branch,
        nodeCount: r.node_count,
        edgeCount: r.edge_count,
        communityCount: r.community_count,
        modularity: r.modularity,
        avgPagerankMax: r.avg_pagerank_max,
        avgBetweennessMax: r.avg_betweenness_max,
        healthScore: r.health_score,
        cohesion: r.cohesion,
        complexity: r.complexity,
        cycleCount: r.cycle_count,
        hubCount: r.hub_count,
        unstableDepCount: r.unstable_dep_count,
      }));
    },

    diffSnapshots(fromId: string, toId: string): SnapshotDiff | null {
      const from = getSnapshotById.get(fromId) as SnapshotRow | undefined;
      const to = getSnapshotById.get(toId) as SnapshotRow | undefined;
      if (!from || !to) return null;

      return {
        nodesAdded: to.node_count - from.node_count,
        nodesRemoved: Math.max(0, from.node_count - to.node_count),
        edgesAdded: to.edge_count - from.edge_count,
        edgesRemoved: Math.max(0, from.edge_count - to.edge_count),
        healthDelta: Math.round((to.health_score - from.health_score) * 100) / 100,
        newCycles: Math.max(0, to.cycle_count - from.cycle_count),
        resolvedCycles: Math.max(0, from.cycle_count - to.cycle_count),
      };
    },

    close(): void {
      db.close();
    },
  };
}
