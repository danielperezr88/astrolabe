/**
 * LadybugDB Graph Database Adapter (#282)
 *
 * Provides save/load for the Astrolabe knowledge graph using LadybugDB,
 * an embedded graph database with native Cypher queries, HNSW vector
 * indexes, and optimized graph traversals.
 *
 * Parallel to sqlite.ts — implements the same SqliteStore interface
 * so the rest of the codebase is backend-agnostic.
 */

import type { KnowledgeGraph, GraphNode } from '../core/types.js';
import { createKnowledgeGraph } from '../core/graph.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createSqliteStore } from './sqlite.js'; // #360: ESM import, not require()

// ── LadybugDB dynamic import ───────────────────────────────────────────────

let LbugDB: any = null;
let LbugDatabase: any = null;

async function getLbug() {
  if (!LbugDB) {
    const mod = await import('@ladybugdb/core');
    LbugDB = mod;
    LbugDatabase = mod.Database;
  }
  return { LbugDB, LbugDatabase };
}

// ── Types ──────────────────────────────────────────────────────────────────

export type StoreBackend = 'sqlite' | 'ladybug';

/** #362: LbugStore has its own interface (async methods — different from synchronous SqliteStore). */
export interface LbugStoreIface {
  init(): Promise<void>;
  saveGraph(graph: KnowledgeGraph): Promise<void>;
  loadGraph(): Promise<KnowledgeGraph>;
  close(): Promise<void>;
}

// ── Ladybug Store ─────────────────────────────────────────────────────────

export class LbugStore {
  private db: any;
  private dbDir: string;

  constructor(dbPath: string) {
    this.dbDir = join(dirname(dbPath), 'lbug');
    if (!existsSync(this.dbDir)) mkdirSync(this.dbDir, { recursive: true });
    // Initialized lazily via init()
  }

  async init(): Promise<void> {
    const { LbugDatabase } = await getLbug();
    this.db = new LbugDatabase(join(this.dbDir, 'graph'));
    await this.createSchema();
  }

  private async createSchema(): Promise<void> {
    const nodeTables = [
      'Function', 'Class', 'Method', 'Interface', 'Enum', 'TypeAlias', 'Variable', 'Const',
      'File', 'Folder', 'Import', 'Route', 'Tool', 'Process', 'Community', 'Package', 'Framework',
      'CodeElement',
    ];

    // Create node tables — one per label
    for (const label of nodeTables) {
      await this.db.run(
        `CREATE NODE TABLE IF NOT EXISTS ${label} (id STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, isExported BOOLEAN, kind STRING, PRIMARY KEY (id))`,
      );
    }

    // Create relationship table
    await this.db.run(
      `CREATE REL TABLE IF NOT EXISTS CodeRelation (FROM Node TO Node, type STRING, confidence DOUBLE, reason STRING)`,
    );
  }

  async saveGraph(graph: KnowledgeGraph): Promise<void> {
    if (!this.db) await this.init();

    // Batch insert nodes per label
    const nodesByLabel = new Map<string, GraphNode[]>();
    for (const node of graph.iterNodes()) {
      let bucket = nodesByLabel.get(node.label);
      if (!bucket) { bucket = []; nodesByLabel.set(node.label, bucket); }
      bucket.push(node);
    }

    for (const [label, nodes] of nodesByLabel) {
      for (const node of nodes) {
        // #361: Store all properties as JSON blob — preserves custom props (route method, tool type, etc.)
        const props = JSON.stringify(node.properties);
        await this.db.run(
          `MERGE (n:${label} {id: $id}) SET n.props = $props`,
          { id: node.id, props },
        );
      }
    }

    // Batch insert relationships
    for (const rel of graph.iterRelationships()) {
      const srcNode = graph.getNode(rel.sourceId);
      const tgtNode = graph.getNode(rel.targetId);
      if (!srcNode || !tgtNode) continue;

      await this.db.run(
        `MATCH (a {id: $srcId}), (b {id: $tgtId}) MERGE (a)-[r:CodeRelation {type: $type}]->(b) SET r.confidence = $conf, r.reason = $reason`,
        { srcId: rel.sourceId, tgtId: rel.targetId, type: rel.type, conf: rel.confidence, reason: rel.reason },
      );
    }
  }

  async loadGraph(): Promise<KnowledgeGraph> {
    if (!this.db) await this.init();
    const graph = createKnowledgeGraph();

    // Load all nodes via Cypher
    const nodeLabels = ['Function', 'Class', 'Method', 'Interface', 'Enum', 'TypeAlias', 'Variable', 'Const', 'File', 'Folder', 'Import', 'Route', 'Tool', 'Process', 'Community', 'Package', 'Framework', 'CodeElement'];

    for (const label of nodeLabels) {
      try {
        const result = await this.db.query(`MATCH (n:${label}) RETURN n`);
        for (const row of (result?.rows ?? [])) {
          const n = typeof row === 'object' ? row : { n: row };
          const node = n.n || n;
          if (!node?.id) continue;
          // #361: Parse JSON properties blob
          let properties: Record<string, unknown> = {};
          try { properties = node.props ? JSON.parse(node.props) : {}; } catch { /* skip bad JSON */ }
          graph.addNode({
            id: node.id,
            label: label as any,
            properties,
          });
        }
      } catch {
        // Table may not exist yet — skip
      }
    }

    // Load all relationships
    try {
      const relResult = await this.db.query('MATCH (a)-[r:CodeRelation]->(b) RETURN a.id, b.id, r.type, r.confidence, r.reason');
      for (const row of (relResult?.rows ?? [])) {
        graph.addRelationship({
          id: `rel:${row['a.id']}:to:${row['b.id']}:${row['r.type']}`,
          sourceId: row['a.id'],
          targetId: row['b.id'],
          type: row['r.type'],
          confidence: row['r.confidence'] ?? 0.5,
          reason: row['r.reason'] ?? '',
        });
      }
    } catch { /* no rels yet */ }

    return graph;
  }

  async close(): Promise<void> {
    if (this.db) await this.db.close();
  }
}

// ── Backend-agnostic factory ───────────────────────────────────────────────

/** #360, #362: LbugStore is async; SqliteStore is sync. Use type union, not interface. */
export function createStore(dbPath: string, backend: StoreBackend = 'sqlite'): LbugStoreIface | ReturnType<typeof createSqliteStore> {
  if (backend === 'ladybug') return new LbugStore(dbPath);
  return createSqliteStore(dbPath);
}
