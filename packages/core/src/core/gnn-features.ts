/**
 * GNN Node Classification Feature Engineering (#809).
 *
 * Extracts typed feature vectors from the Astrolabe knowledge graph for
 * training Graph Neural Network models (node classification, link prediction).
 *
 * Pipeline:
 *   extractNodeFeatures(graph) → Map<string, GnnNodeFeatures>
 *   extractEdgeFeatures(graph) → Map<string, GnnEdgeFeatures>
 *   exportGnnDataset(graph, outputPath) → writes nodes.csv, edges.csv, labels.json
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { KnowledgeGraph, GraphNode, GraphRelationship, NodeLabel, RelationshipType } from '@astrolabe-dev/shared';
import { pageRank, betweennessCentrality } from './graph-algorithms.js';

// ── Fixed label / edge-type lists for one-hot encoding ────────────────────

/** All 37 node labels in the Astrolabe taxonomy — used for one-hot encoding. */
export const NODE_LABELS: readonly NodeLabel[] = [
  'Project', 'Package', 'Module', 'Folder', 'File',
  'Class', 'Function', 'Method', 'Variable',
  'Interface', 'Enum', 'Decorator', 'Import', 'Type',
  'CodeElement', 'Community', 'Process',
  'Struct', 'Macro', 'Typedef', 'Union', 'Namespace',
  'Trait', 'Impl', 'TypeAlias', 'Const', 'Static',
  'Property', 'Record', 'Delegate', 'Annotation',
  'Constructor', 'Template', 'Section', 'Route', 'Tool',
  'Framework',
] as const;

/** All 26 relationship types — used for one-hot encoding of edge types. */
export const EDGE_TYPES: readonly RelationshipType[] = [
  'CONTAINS', 'CALLS', 'EXTENDS', 'METHOD_OVERRIDES',
  'METHOD_IMPLEMENTS', 'IMPORTS', 'USES', 'DEFINES', 'DECORATES',
  'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'ACCESSES',
  'MEMBER_OF', 'STEP_IN_PROCESS', 'HANDLES_ROUTE', 'FETCHES',
  'HANDLES_TOOL', 'ENTRY_POINT_OF', 'WRAPS', 'QUERIES',
  'USES_FRAMEWORK', 'RETURNS_TYPE', 'DECLARES_TYPE',
  'CHAINABLE_TO', 'SEMANTICALLY_SIMILAR',
] as const;

// ── Feature types ─────────────────────────────────────────────────────────

/** GNN-ready numeric features for a single graph node. */
export interface GnnNodeFeatures {
  nodeId: string;
  label: string;
  /** One-hot encoding of the node label (length = NODE_LABELS.length). */
  labelEncoding: number[];
  /** Number of incoming relationships (any type). */
  degreeIn: number;
  /** Number of outgoing relationships (any type). */
  degreeOut: number;
  /** PageRank score from the directed structural adjacency list. */
  pageRankScore: number;
  /** Betweenness centrality score from the undirected adjacency list. */
  betweennessCentrality: number;
  /** Numeric community ID (0-based, or -1 if unassigned). */
  communityId: number;
  /** Static code metrics (zero for non-code nodes). */
  codeMetrics: {
    parameterCount: number;
    isAsync: boolean;
    isStatic: boolean;
    isAbstract: boolean;
    linesOfCode: number;
    nestingLevel: number;
  };
  /** Optional 384-D semantic embedding vector, or null if not available. */
  embedding: number[] | null;
}

/** GNN-ready numeric features for a single edge. */
export interface GnnEdgeFeatures {
  edgeId: string;
  sourceId: string;
  targetId: string;
  type: string;
  /** One-hot encoding of the edge type (length = EDGE_TYPES.length). */
  typeEncoding: number[];
  /** Edge confidence (0–1). */
  confidence: number;
  /** Whether source and target belong to different communities. */
  crossCommunity: boolean;
}

/** Options controlling the GNN dataset export. */
export interface GnnExportOptions {
  /** Path to the Astrolabe SQLite DB (for loading embeddings). */
  dbPath?: string;
  /** Whether to include embedding vectors in node features. */
  includeEmbeddings?: boolean;
  /** Output format: 'csv' (default) or 'json'. */
  format?: 'csv' | 'json';
}

// ── One-hot helpers ───────────────────────────────────────────────────────

const labelIndexMap = new Map<string, number>();
for (let i = 0; i < NODE_LABELS.length; i++) {
  labelIndexMap.set(NODE_LABELS[i], i);
}

const edgeTypeIndexMap = new Map<string, number>();
for (let i = 0; i < EDGE_TYPES.length; i++) {
  edgeTypeIndexMap.set(EDGE_TYPES[i], i);
}

/**
 * One-hot encode a node label into a fixed-length binary vector.
 * Unknown labels produce an all-zero vector.
 */
export function nodeLabelOneHot(label: string): number[] {
  const vec = new Array<number>(NODE_LABELS.length).fill(0);
  const idx = labelIndexMap.get(label);
  if (idx !== undefined) vec[idx] = 1;
  return vec;
}

function edgeTypeOneHot(type: string): number[] {
  const vec = new Array<number>(EDGE_TYPES.length).fill(0);
  const idx = edgeTypeIndexMap.get(type);
  if (idx !== undefined) vec[idx] = 1;
  return vec;
}

// ── Adjacency list builder ────────────────────────────────────────────────

/**
 * Build a directed adjacency list from ALL relationship types.
 * Returns Map<nodeId, targetId[]> where each edge is sourceId → targetId.
 * All node IDs from nodes and relationships are included (even isolates).
 */
function buildFullAdjacency(
  nodes: Iterable<GraphNode>,
  relationships: Iterable<GraphRelationship>,
): Map<string, string[]> {
  const adj = new Map<string, string[]>();

  // Ensure every node has an entry (even isolates)
  for (const node of nodes) {
    if (!adj.has(node.id)) adj.set(node.id, []);
  }

  for (const rel of relationships) {
    let bucket = adj.get(rel.sourceId);
    if (!bucket) { bucket = []; adj.set(rel.sourceId, bucket); }
    bucket.push(rel.targetId);

    // Ensure target also has an entry
    if (!adj.has(rel.targetId)) adj.set(rel.targetId, []);
  }

  return adj;
}

// ── Community index builder ───────────────────────────────────────────────

/**
 * Build a nodeId → communityId index.
 *
 * Priority:
 *  1. `node.properties._community` (set by communityPhase on member nodes).
 *  2. MEMBER_OF edges linking the node to a Community node.
 *
 * Returns a Map<nodeId, communityIndex> where communityIndex is a 0-based
 * integer. Unassigned nodes get -1.
 */
function buildCommunityIndex(
  nodes: Iterable<GraphNode>,
  relationships: Iterable<GraphRelationship>,
): Map<string, number> {
  const communityOf = new Map<string, number>();
  const communityIdToIndex = new Map<string, number>();
  let nextIndex = 0;

  // Pass 1: check _community on nodes
  for (const node of nodes) {
    const cid = node.properties._community;
    if (typeof cid === 'string' && cid.length > 0) {
      let idx = communityIdToIndex.get(cid);
      if (idx === undefined) {
        idx = nextIndex++;
        communityIdToIndex.set(cid, idx);
      }
      communityOf.set(node.id, idx);
    }
  }

  // Pass 2: MEMBER_OF edges for nodes without explicit _community
  for (const rel of relationships) {
    if (rel.type !== 'MEMBER_OF') continue;
    if (communityOf.has(rel.sourceId)) continue; // already assigned

    const targetNode = findNodeById(nodes, rel.targetId);
    if (targetNode && targetNode.label === 'Community') {
      const cid = (targetNode.properties.name as string) ?? targetNode.id;
      let idx = communityIdToIndex.get(cid);
      if (idx === undefined) {
        idx = nextIndex++;
        communityIdToIndex.set(cid, idx);
      }
      communityOf.set(rel.sourceId, idx);
    }
  }

  return communityOf;
}

/** Naive O(N) lookup — cached result via Map. */
function findNodeById(nodes: Iterable<GraphNode>, id: string): GraphNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
  }
  return undefined;
}

// ── Core feature extraction ───────────────────────────────────────────────

/**
 * Extract typed feature vectors for every node in the knowledge graph.
 *
 * Computes:
 *  - One-hot label encoding
 *  - In/out degree (all relationship types)
 *  - PageRank and betweenness centrality (structural adjacency)
 *  - Community assignment (from _community or MEMBER_OF edges)
 *  - Static code metrics (for code-bearing nodes)
 *  - Optional embedding vectors from the embedding store
 */
export function extractNodeFeatures(
  graph: KnowledgeGraph,
  options?: { dbPath?: string; includeEmbeddings?: boolean },
): Map<string, GnnNodeFeatures> {
  // Collect all nodes once
  const nodeList: GraphNode[] = [];
  const nodeMap = new Map<string, GraphNode>();
  for (const node of graph.iterNodes()) {
    nodeList.push(node);
    nodeMap.set(node.id, node);
  }

  // Build structural adjacency for algorithms
  const adjList = buildFullAdjacency(
    nodeList,
    graph.iterRelationships(),
  );

  // Run PageRank & betweenness centrality
  const prScores = new Map<string, number>();
  for (const r of pageRank(adjList)) {
    prScores.set(r.nodeId, r.score);
  }

  const bcScores = new Map<string, number>();
  for (const r of betweennessCentrality(adjList)) {
    bcScores.set(r.nodeId, r.score);
  }

  // Compute raw degrees (in/out) from the full adjacency list
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  for (const [src, targets] of adjList) {
    outDegree.set(src, targets.length);
    for (const tgt of targets) {
      inDegree.set(tgt, (inDegree.get(tgt) ?? 0) + 1);
    }
  }

  // Community index
  const communityOf = buildCommunityIndex(nodeList, graph.iterRelationships());

  // Optional embeddings
  let embeddings: Map<string, number[]> | null = null;
  if (options?.includeEmbeddings && options?.dbPath) {
    embeddings = loadEmbeddings(options.dbPath);
  }

  // Build feature vectors
  const features = new Map<string, GnnNodeFeatures>();
  for (const node of nodeList) {
    const props = node.properties;
    const startLine = props.startLine ?? 0;
    const endLine = props.endLine ?? startLine;

    features.set(node.id, {
      nodeId: node.id,
      label: node.label,
      labelEncoding: nodeLabelOneHot(node.label),
      degreeIn: inDegree.get(node.id) ?? 0,
      degreeOut: outDegree.get(node.id) ?? 0,
      pageRankScore: prScores.get(node.id) ?? 0,
      betweennessCentrality: bcScores.get(node.id) ?? 0,
      communityId: communityOf.get(node.id) ?? -1,
      codeMetrics: {
        parameterCount: (props.parameterCount as number) ?? 0,
        isAsync: (props.isAsync as boolean) ?? false,
        isStatic: (props.isStatic as boolean) ?? false,
        isAbstract: (props.isAbstract as boolean) ?? false,
        linesOfCode: endLine > startLine ? endLine - startLine + 1 : 0,
        nestingLevel: (props.level as number) ?? 0,
      },
      embedding: embeddings?.get(node.id) ?? null,
    });
  }

  return features;
}

/**
 * Extract typed feature vectors for every edge in the knowledge graph.
 *
 * Computes:
 *  - One-hot edge-type encoding
 *  - Confidence score
 *  - Cross-community flag (source and target in different communities)
 */
export function extractEdgeFeatures(
  graph: KnowledgeGraph,
): Map<string, GnnEdgeFeatures> {
  // Collect nodes for community lookups
  const nodeList: GraphNode[] = [];
  for (const node of graph.iterNodes()) nodeList.push(node);

  const communityOf = buildCommunityIndex(nodeList, graph.iterRelationships());

  const features = new Map<string, GnnEdgeFeatures>();
  for (const rel of graph.iterRelationships()) {
    const srcComm = communityOf.get(rel.sourceId) ?? -1;
    const tgtComm = communityOf.get(rel.targetId) ?? -1;

    features.set(rel.id, {
      edgeId: rel.id,
      sourceId: rel.sourceId,
      targetId: rel.targetId,
      type: rel.type,
      typeEncoding: edgeTypeOneHot(rel.type),
      confidence: rel.confidence,
      crossCommunity: srcComm !== tgtComm || (srcComm === -1 && tgtComm === -1) ? srcComm !== tgtComm : false,
    });
  }

  return features;
}

// ── Embedding store loader ────────────────────────────────────────────────

/**
 * Load embedding vectors from the SQLite embedding store.
 * Returns Map<nodeId, vector> or null if the store isn't available.
 */
function loadEmbeddings(dbPath: string): Map<string, number[]> | null {
  try {
    // Dynamic import to avoid requiring better-sqlite3 at module load time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3');
    const db = new BetterSqlite3(dbPath);

    const hasTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'",
    ).get();

    if (!hasTable) {
      db.close();
      return null;
    }

    const rows = db.prepare('SELECT node_id, vector FROM embeddings').all() as Array<{
      node_id: string;
      vector: Buffer | ArrayBuffer;
    }>;

    db.close();

    const result = new Map<string, number[]>();
    for (const row of rows) {
      const vec = Array.from(new Float32Array(row.vector as ArrayBuffer));
      result.set(row.node_id, vec);
    }

    return result;
  } catch {
    return null;
  }
}

// ── Dataset export ────────────────────────────────────────────────────────

function flattenNodeFeatures(f: GnnNodeFeatures): Record<string, unknown> {
  return {
    nodeId: f.nodeId,
    label: f.label,
    ...Object.fromEntries(f.labelEncoding.map((v, i) => [`label_${i}`, v])),
    degreeIn: f.degreeIn,
    degreeOut: f.degreeOut,
    pageRankScore: f.pageRankScore,
    betweennessCentrality: f.betweennessCentrality,
    communityId: f.communityId,
    parameterCount: f.codeMetrics.parameterCount,
    isAsync: f.codeMetrics.isAsync ? 1 : 0,
    isStatic: f.codeMetrics.isStatic ? 1 : 0,
    isAbstract: f.codeMetrics.isAbstract ? 1 : 0,
    linesOfCode: f.codeMetrics.linesOfCode,
    nestingLevel: f.codeMetrics.nestingLevel,
    hasEmbedding: f.embedding !== null ? 1 : 0,
  };
}

function flattenEdgeFeatures(f: GnnEdgeFeatures): Record<string, unknown> {
  return {
    edgeId: f.edgeId,
    sourceId: f.sourceId,
    targetId: f.targetId,
    type: f.type,
    ...Object.fromEntries(f.typeEncoding.map((v, i) => [`type_${i}`, v])),
    confidence: f.confidence,
    crossCommunity: f.crossCommunity ? 1 : 0,
  };
}

/**
 * Export the GNN dataset to disk.
 *
 * Writes to `outputPath/`:
 *  - `nodes.csv` (or `nodes.json`): flattened node features
 *  - `edges.csv` (or `edges.json`): flattened edge features
 *  - `node_labels.json`: mapping of nodeId → label
 *  - `edge_types.json`: mapping of edge type → numeric index
 *
 * Returns a summary object with counts and feature dimensions.
 */
export function exportGnnDataset(
  graph: KnowledgeGraph,
  outputPath: string,
  options?: GnnExportOptions,
): {
  nodeCount: number;
  edgeCount: number;
  featureDimensions: number;
  exportPath: string;
} {
  const format = options?.format ?? 'csv';

  // Extract features
  const nodeFeatures = extractNodeFeatures(graph, {
    dbPath: options?.dbPath,
    includeEmbeddings: options?.includeEmbeddings,
  });
  const edgeFeatures = extractEdgeFeatures(graph);

  // Ensure output directory exists
  if (!existsSync(outputPath)) {
    mkdirSync(outputPath, { recursive: true });
  }

  // Helper to escape CSV fields
  const csvEscape = (val: unknown): string => {
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  // Write nodes
  const nodeList = Array.from(nodeFeatures.values());
  const featureDimensions = nodeList.length > 0
    ? nodeLabelOneHot(nodeList[0].label).length
    : NODE_LABELS.length;

  if (format === 'json') {
    writeFileSync(
      pathJoin(outputPath, 'nodes.json'),
      JSON.stringify(nodeList.map(flattenNodeFeatures), null, 2),
      'utf-8',
    );
  } else {
    const nodeHeaders = ['nodeId', 'label',
      ...Array.from({ length: NODE_LABELS.length }, (_, i) => `label_${i}`),
      'degreeIn', 'degreeOut', 'pageRankScore', 'betweennessCentrality',
      'communityId', 'parameterCount', 'isAsync', 'isStatic', 'isAbstract',
      'linesOfCode', 'nestingLevel', 'hasEmbedding',
    ].join(',');

    const nodeRows = nodeList.map(flattenNodeFeatures).map((row) =>
      nodeHeaders
        .split(',')
        .map((col) => csvEscape(row[col]))
        .join(','),
    );

    writeFileSync(
      pathJoin(outputPath, 'nodes.csv'),
      [nodeHeaders, ...nodeRows].join('\n'),
      'utf-8',
    );
  }

  // Write edges
  const edgeList = Array.from(edgeFeatures.values());
  if (format === 'json') {
    writeFileSync(
      pathJoin(outputPath, 'edges.json'),
      JSON.stringify(edgeList.map(flattenEdgeFeatures), null, 2),
      'utf-8',
    );
  } else {
    const edgeHeaders = ['edgeId', 'sourceId', 'targetId', 'type',
      ...Array.from({ length: EDGE_TYPES.length }, (_, i) => `type_${i}`),
      'confidence', 'crossCommunity',
    ].join(',');

    const edgeRows = edgeList.map(flattenEdgeFeatures).map((row) =>
      edgeHeaders
        .split(',')
        .map((col) => csvEscape(row[col]))
        .join(','),
    );

    writeFileSync(
      pathJoin(outputPath, 'edges.csv'),
      [edgeHeaders, ...edgeRows].join('\n'),
      'utf-8',
    );
  }

  // Write metadata
  writeFileSync(
    pathJoin(outputPath, 'node_labels.json'),
    JSON.stringify(Object.fromEntries(
      NODE_LABELS.map((label, i) => [label, i]),
    ), null, 2),
    'utf-8',
  );

  writeFileSync(
    pathJoin(outputPath, 'edge_types.json'),
    JSON.stringify(Object.fromEntries(
      EDGE_TYPES.map((type, i) => [type, i]),
    ), null, 2),
    'utf-8',
  );

  return {
    nodeCount: nodeList.length,
    edgeCount: edgeList.length,
    featureDimensions,
    exportPath: outputPath,
  };
}
