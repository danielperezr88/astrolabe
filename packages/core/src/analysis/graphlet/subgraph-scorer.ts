/**
 * Subgraph-aware architecture scoring for multi-language/disconnected codebases (#968).
 *
 * Partitions the knowledge graph by language + directory boundaries,
 * scores each subgraph independently, and computes a weighted aggregate.
 */

import type { KnowledgeGraph } from '../../core/types.js';
import { countGraphlets } from './counter.js';
import { scoreArchitectureHealth, type ArchitectureHealth } from './health.js';
import { detectPatterns, type ArchitecturePattern, buildAdjacencyMap } from './index.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SubgraphInfo {
  name: string;
  language: string;
  nodeIds: string[];
  nodeCount: number;
  /** Whether this is a code subgraph (vs docs/config) */
  isCode: boolean;
}

export interface SubgraphScore {
  name: string;
  language: string;
  nodeCount: number;
  edgeCount: number;
  health: ArchitectureHealth;
  patterns: ArchitecturePattern[];
  /** Whether scoring was meaningful (code subgraphs only) */
  scored: boolean;
}

export interface SubgraphArchitectureResult {
  subgraphs: SubgraphInfo[];
  scores: SubgraphScore[];
  overallHealth: number;
  overallLabel: string;
}

// ── Subgraph Detection ─────────────────────────────────────────────────────

const DOCS_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml']);
const CONFIG_DIRS = new Set(['.github', 'docs', '.vscode']);
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', '.astrolabe', '__pycache__']);

function isDocsConfig(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  if (DOCS_EXTENSIONS.has(ext)) return true;
  for (const dir of CONFIG_DIRS) {
    if (filePath.startsWith(dir + '/') || filePath.startsWith(dir + '\\')) return true;
  }
  return false;
}

function isExcludedDir(filePath: string): boolean {
  for (const dir of EXCLUDED_DIRS) {
    if (filePath.includes('/' + dir + '/') || filePath.includes('\\' + dir + '\\')) return true;
    if (filePath.startsWith(dir + '/') || filePath.startsWith(dir + '\\')) return true;
  }
  return false;
}

/**
 * Detect subgraphs from a knowledge graph by partitioning nodes
 * into language + directory groups.
 */
export function detectSubgraphs(
  graph: KnowledgeGraph,
  minNodes = 5,
): SubgraphInfo[] {
  const subgraphs = new Map<string, { language: string; nodeIds: string[]; isCode: boolean }>();

  for (const node of graph.iterNodes()) {
    const fp = node.properties.filePath as string | undefined;
    if (!fp || isExcludedDir(fp)) continue;

    const isDoc = isDocsConfig(fp);
    const ext = fp.substring(fp.lastIndexOf('.')).toLowerCase();
    const topDir = fp.split(/[/\\]/)[0] || 'root';

    // Key: topDir:language — groups by both directory and language
    const lang = isDoc ? 'docs-config' : (fp.endsWith('.py') ? 'python' : ext);
    const key = `${topDir}:${lang}`;

    let sub = subgraphs.get(key);
    if (!sub) {
      sub = { language: lang, nodeIds: [], isCode: !isDoc };
      subgraphs.set(key, sub);
    }
    sub.nodeIds.push(node.id);
  }

  return Array.from(subgraphs.entries())
    .map(([key, sub]) => ({
      name: key,
      language: sub.language,
      nodeIds: sub.nodeIds,
      nodeCount: sub.nodeIds.length,
      isCode: sub.isCode,
    }))
    .filter(s => s.nodeCount >= minNodes)
    .sort((a, b) => b.nodeCount - a.nodeCount);
}

// ── Per-Subgraph Scoring ───────────────────────────────────────────────────

/**
 * Score architecture health for each subgraph independently.
 *
 * For each subgraph:
 * 1. Filters the adjacency map to only subgraph edges
 * 2. Counts graphlets within the subgraph
 * 3. Scores health using existing `scoreArchitectureHealth`
 * 4. Detects patterns using existing `detectPatterns`
 *
 * Documentation/config subgraphs are skipped (marked scored=false).
 */
export function scoreSubgraphs(
  graph: KnowledgeGraph,
  subgraphs: SubgraphInfo[],
): SubgraphScore[] {
  const nodeIds = new Set<string>();
  for (const node of graph.iterNodes()) nodeIds.add(node.id);

  const fullAdjMap = buildAdjacencyMap(graph.iterRelationships(), nodeIds);

  return subgraphs.map((sub) => {
    if (!sub.isCode || sub.nodeCount < 10) {
      return {
        name: sub.name,
        language: sub.language,
        nodeCount: sub.nodeCount,
        edgeCount: 0,
        health: { overallScore: 0, cohesion: 0, modularity: 0, complexity: 0, antiPatterns: [] },
        patterns: [],
        scored: false,
      };
    }

    // Build subgraph adjacency map
    const subNodeSet = new Set(sub.nodeIds);
    const subAdjMap = new Map<string, Set<string>>();

    for (const nodeId of sub.nodeIds) {
      const fullNeighbors = fullAdjMap.get(nodeId);
      if (fullNeighbors) {
        const filtered = new Set<string>();
        for (const neighbor of fullNeighbors) {
          if (subNodeSet.has(neighbor)) filtered.add(neighbor);
        }
        if (filtered.size > 0) subAdjMap.set(nodeId, filtered);
      }
    }

    // Count graphlets within subgraph
    const subNodes = Array.from(graph.iterNodes()).filter(n => subNodeSet.has(n.id));
    const profile = countGraphlets(subNodes, subAdjMap);

    const communities = [{ id: sub.name, nodeCount: sub.nodeCount }];
    const health = scoreArchitectureHealth(profile, communities, subAdjMap);
    const patterns = detectPatterns(profile);

    return {
      name: sub.name,
      language: sub.language,
      nodeCount: sub.nodeCount,
      edgeCount: profile.edgeCount,
      health,
      patterns,
      scored: true,
    };
  });
}

// ── Weighted Aggregate ─────────────────────────────────────────────────────

/**
 * Compute a weighted aggregate health score across all subgraphs.
 *
 * Weights are proportional to node count. Documentation/config subgraphs
 * are excluded from the aggregate.
 */
export function computeAggregateHealth(scores: SubgraphScore[]): { overallHealth: number; overallLabel: string } {
  const codeScores = scores.filter(s => s.scored);

  if (codeScores.length === 0) return { overallHealth: 0, overallLabel: 'No code subgraphs' };

  const totalNodes = codeScores.reduce((sum, s) => sum + s.nodeCount, 0);
  if (totalNodes === 0) return { overallHealth: 0, overallLabel: 'Empty' };

  let weightedScore = 0;
  for (const s of codeScores) {
    weightedScore += s.health.overallScore * (s.nodeCount / totalNodes);
  }

  const overall = Math.round(weightedScore);

  let label: string;
  if (overall >= 75) label = 'Healthy';
  else if (overall >= 50) label = 'Fair';
  else if (overall >= 25) label = 'At risk';
  else label = 'Poor';

  return { overallHealth: overall, overallLabel: label };
}

// ── Main Orchestrator ──────────────────────────────────────────────────────

export function analyzeSubgraphArchitecture(graph: KnowledgeGraph): SubgraphArchitectureResult {
  const subgraphs = detectSubgraphs(graph);
  const scores = scoreSubgraphs(graph, subgraphs);
  const aggregate = computeAggregateHealth(scores);

  return {
    subgraphs,
    scores,
    overallHealth: aggregate.overallHealth,
    overallLabel: aggregate.overallLabel,
  };
}
