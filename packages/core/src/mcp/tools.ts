/**
 * MCP Tool definitions - all 29 tool registrations.
 *
 * Extracted from server.ts for modularity (#838).
 * Uses factory pattern: createTools(backend) returns the TOOLS record.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { listGroups, getGroupStatus, groupQuery } from './groups.js';
import { syncGroupContracts, getGroupContracts } from './contracts.js';
import { routeMap, toolMap, apiImpact, shapeCheck } from './api-tools.js';
import { executeTraversal, type TraversalQuery } from './traverse.js';
import { PhaseTimer } from '../core/phase-timer.js';
import { pageRank, betweennessCentrality, shortestPath, detectClones, computeSpectralMetrics, detectCutVertices, detectBridges, architectureSmells } from '../core/graph-algorithms.js';
import { chat as ragChat, type ChatMessage } from '../agent/rag-chat.js';
import { generateDiagram, generateMarkdownDoc, type DiagramType, type DiagramOptions } from './diagram-generator.js';
import { countGraphlets, buildAdjacencyMap, detectPatterns, scoreArchitectureHealth } from '../analysis/graphlet/index.js';
import type { CommunityInfo } from '../analysis/graphlet/index.js';
import { computeGraphCoverageMetrics } from '../analysis/coverage/graph-metrics.js';
import { exportGnnDataset } from '../core/gnn-features.js';
import { EmbeddingStore, createEmbeddingProvider, type EmbeddingProviderType } from '../search/embeddings-store.js';
import { cosineSimilarity } from '../core/embedding-propagation.js';
import { detectTrends } from '../core/graph-evolution.js';
import type { LocalBackend, RepoContext } from './backend.js';

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
};

function requireString(params: Record<string, unknown>, key: string): string {
  const val = params[key];
  if (typeof val !== 'string' || val.length === 0) throw new Error(`Missing or invalid parameter: ${key}`);
  return val;
}
function requireNumber(params: Record<string, unknown>, key: string, fallback: number): number {
  const val = params[key];
  if (val === undefined || val === null) return fallback;
  if (typeof val !== 'number') throw new Error(`Invalid parameter: ${key} (expected number, got ${typeof val})`);
  return val;
}

export function createTools(backend: LocalBackend): Record<string, ToolDefinition> {
const TOOLS: Record<string, ToolDefinition> = {

  'astrolabe.list_repos': {
    name: 'astrolabe.list_repos',
    description: 'Discover all indexed repositories. Read this first before using other tools.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const repos = backend.listRepos();
      if (repos.length === 0) return { content: [{ type: 'text', text: 'No indexed repositories. Run `astrolabe analyze <path>` first.' }] };
      const lines = repos.map((r) => `${r.name} (${r.path}) — ${new Date(r.indexedAt).toISOString()}`);
      return { content: [{ type: 'text', text: `Indexed repositories:\n${lines.join('\n')}\n\nNext: use query({query: "your search"}) or context({name: "symbolName"}). For complex graph patterns, use cypher({match: {...}}). Read astrolabe://repo/{name}/schema for node labels and relationship types.` }] };
    },
  },

  'astrolabe.query': {
    name: 'astrolabe.query',
    description: `Hybrid search over the knowledge graph. Returns process-grouped results for architectural context.

GROUP MODE: set "repo" to "@<groupName>" to search all member repos in that group, or "@<groupName>/<memberPath>" to scope to one member. Use "service" for monorepo subdirectory filtering.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (symbol name, concept, etc.)' },
        limit: { type: 'number', description: 'Max results', default: 20 },
        repo: { type: 'string', description: 'Repository name, or "@<groupName>" / "@<groupName>/<memberPath>" for group mode. Omit if only one repo indexed.' },
        service: { type: 'string', description: 'Optional monorepo path prefix filter (only active in group mode)' },
        task_context: { type: 'string', description: 'Context about the current task (e.g., "debugging auth flow")' },
        goal: { type: 'string', description: 'What the search aims to find (e.g., "find where tokens are validated")' },
        mode: { type: 'string', enum: ['hybrid', 'semantic'], description: 'Search mode: hybrid (FTS + TF-IDF, default) or semantic (embedding cosine similarity)', default: 'hybrid' },
        embedding_provider: { type: 'string', description: 'Embedding provider for semantic mode: auto, transformers, tfidf, remote. Default auto.', default: 'auto' },
        propagate_hops: { type: 'number', description: 'Propagation hops for semantic embeddings (0=none, 1=single, 2=double). Default 0.', default: 0 },
      },
      required: ['query'],
    },
    handler: async (params) => {
      const timer = new PhaseTimer('query');
      timer.start();
      const query = requireString(params, 'query');
      const repo = params.repo as string | undefined;
      const service = params.service as string | undefined;
      const taskContext = params.task_context as string | undefined;
      const goal = params.goal as string | undefined;
      const mode = (params.mode as string) ?? 'hybrid';
      let result: unknown;

      // #813: Semantic search mode
      if (mode === 'semantic') {
        // Get repo context for dbPath
        const ctx = repo?.startsWith('@')
          ? backend.resolveGroupRepos(repo).contexts[0]?.repo
          : backend.getRepo(repo);

        if (!ctx) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'No indexed repository found. Use astrolabe embed first.' }) }] };
        }

        try {
          const dbPath = ctx.entry.dbPath;
          const embedStore = new EmbeddingStore(new (await import('better-sqlite3')).default(dbPath));
          const providerType = (params.embedding_provider as EmbeddingProviderType) ?? 'auto';
          const provider = createEmbeddingProvider(providerType);
          const demand = provider.dimensions;

          // Compute query embedding
            const effectiveHops = requireNumber(params, 'propagate_hops', 1);
          const hops_used = effectiveHops > 2 ? 2 : effectiveHops < 0 ? 0 : effectiveHops;
          const queryVec = provider.encodeAsync
            ? await provider.encodeAsync(query)
            : provider.encode(query);

          // Load all stored embeddings
          const allEmbs = embedStore.getAll();

          if (allEmbs.length === 0) {
            embedStore.close?.();
            return { content: [{ type: 'text', text: JSON.stringify({ error: 'No embeddings found. Run `astrolabe embed` first.' }) }] };
          }

          // Rank by cosine similarity
          const results: Array<{ nodeId: string; similarity: number; contentHash: string }> = [];
          for (const emb of allEmbs) {
            // Verify dimensionality match
            if (emb.dimensions !== demand) continue;
            const storedVec = Array.from(new Float32Array(emb.vector.buffer));
            if (storedVec.length !== demand) continue;
            const sim = cosineSimilarity(Array.from(queryVec), storedVec);
            results.push({ nodeId: emb.nodeId, similarity: sim, contentHash: emb.contentHash });
          }

          // Sort by similarity descending, take top limit
          results.sort((a, b) => b.similarity - a.similarity);
          const limit = requireNumber(params, 'limit', 20);
          const topResults = results.slice(0, limit);

          // Enrich with node info from the graph
          const graph = ctx.loadGraph();
          const enriched = topResults.map((r) => {
            const node = graph.getNode(r.nodeId);
            return {
              nodeId: r.nodeId,
              name: node?.properties.name ?? r.nodeId,
              label: node?.label ?? 'unknown',
              filePath: node?.properties.filePath ?? '',
              similarity: Math.round(r.similarity * 10000) / 10000,
            };
          });

          embedStore.close?.();
          result = {
            mode: 'semantic',
            hops_used,
            results: enriched,
            total_embeddings: allEmbs.length,
          };
        } catch (err) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: `Semantic search failed: ${(err as Error).message}. Try running \`astrolabe embed\` first.`,
              }),
            }],
          };
        }
      } else {
        // Hybrid mode (existing behavior)
        if (repo?.startsWith('@')) {
          result = backend.queryGroup(query, repo, service, requireNumber(params, 'limit', 20), taskContext, goal);
        } else {
          result = backend.query(query, repo, requireNumber(params, 'limit', 20), taskContext, goal);
        }
      }

      timer.mark('search');
      const nextHint = '\n\nNext: use context({name: "foundSymbol"}) to get 360-degree view of any result.';
      timer.mark('format');
      timer.stop();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.context': {
    name: 'astrolabe.context',
    description: `360-degree symbol view — callers, callees, process membership for one symbol.

GROUP MODE: set "repo" to "@<groupName>" to search all member repos, or "@<groupName>/<memberPath>" for one member.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name or node ID' },
        repo: { type: 'string', description: 'Repository name, or "@<groupName>" / "@<groupName>/<memberPath>" for group mode' },
        service: { type: 'string', description: 'Optional monorepo path prefix filter (only active in group mode)' },
        kind: { type: 'string', description: 'Node label filter (Function, Class, Method, etc.) for disambiguation' },
        file_path: { type: 'string', description: 'File path filter (substring match) for disambiguation' },
      },
      required: ['name'],
    },
    handler: async (params) => {
      const timer = new PhaseTimer('context');
      timer.start();
      const name = requireString(params, 'name');
      const repo = params.repo as string | undefined;
      const service = params.service as string | undefined;
      const kind = params.kind as string | undefined;
      const filePath = params.file_path as string | undefined;
      let result: unknown;

      if (repo?.startsWith('@')) {
        result = backend.contextGroup(name, repo, service, kind, filePath);
      } else {
        result = backend.context(name, repo, kind, filePath);
      }

      timer.mark('lookup');
      const nextHint = '\n\nNext: use impact({target: "symbolName", direction: "upstream"}) for blast radius analysis.';
      timer.mark('format');
      timer.stop();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.impact': {
    name: 'astrolabe.impact',
    description: `Blast radius analysis — what depends on this symbol, grouped by depth with risk levels.

GROUP MODE: set "repo" to "@<groupName>" to anchor impact in a group member and fan out across repos.
crossDepth: cross-repo hop depth via contract bridge (default 0 = single repo, 1+ = fan out).
subgroup: limit cross-repo fan-out to specific member repos.
service: monorepo path prefix filter (only active in group mode).`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Symbol name or node ID to analyze' },
        direction: { type: 'string', enum: ['upstream', 'downstream'], default: 'upstream' },
        maxDepth: { type: 'number', description: 'How many levels to traverse in local graph', default: 5 },
        minConfidence: { type: 'number', description: 'Minimum edge confidence (0.0-1.0)', default: 0.3 },
        crossDepth: { type: 'number', description: 'Cross-repo hop depth via contract bridge (0 = single repo only)', default: 0 },
        timeoutMs: { type: 'number', description: 'Wall-clock budget in ms (default 30000, max 3600000). Returns partial results if exceeded.', default: 30000 },
        repo: { type: 'string', description: 'Repository name, or "@<groupName>" / "@<groupName>/<memberPath>" for group mode' },
        service: { type: 'string', description: 'Optional monorepo path prefix filter (only active in group mode)' },
        subgroup: { type: 'string', description: 'Optional group subgroup prefix limiting cross-repo fan-out' },
        targetUid: { type: 'string', description: 'Exact node ID for zero-ambiguity lookup (skips name resolution)' },
        kind: { type: 'string', description: 'Node label filter for disambiguation when target name is ambiguous' },
        file_path: { type: 'string', description: 'File path filter for disambiguation' },
        mode: { type: 'string', description: 'Impact scoring mode: binary (current) or probabilistic (confidence decay with Noisy-OR fusion)', enum: ['binary', 'probabilistic'] },
        decaySchedule: { type: 'string', description: 'Decay schedule for probabilistic mode (default: linear)', enum: ['linear', 'exponential', 'logarithmic'] },
      },
      required: ['target', 'direction'],
    },
    handler: async (params) => {
      const timer = new PhaseTimer('impact');
      timer.start();
      const target = requireString(params, 'target');
      const repo = params.repo as string | undefined;
      const crossDepth = requireNumber(params, 'crossDepth', 0);
      const timeoutMs = Math.min(requireNumber(params, 'timeoutMs', 30000), 3_600_000);
      const targetUid = params.targetUid as string | undefined;
      const kind = params.kind as string | undefined;
      const filePath = params.file_path as string | undefined;
      const mode = (params.mode as string) ?? 'binary';
      const decaySchedule = (params.decaySchedule as string) ?? 'linear';
      let result: unknown;

      if (repo?.startsWith('@') && crossDepth > 0) {
        // #400: Cross-repo impact with boundary fan-out
        const { contexts, groupName } = backend.resolveGroupRepos(repo);
        // Anchor in first available context
        const anchor = contexts[0];
        if (!anchor) return { content: [{ type: 'text', text: JSON.stringify({ error: `No repos found in group "${groupName}"` }) }] };

        const localResult = backend.impact(
          target,
          (params.direction as 'upstream' | 'downstream') ?? 'upstream',
          anchor.repo.entry.name,
          requireNumber(params, 'maxDepth', 5),
          requireNumber(params, 'minConfidence', 0.3),
          timeoutMs,
          targetUid,
          kind,
          filePath,
          mode as 'binary' | 'probabilistic',
          decaySchedule as 'linear' | 'exponential' | 'logarithmic',
        );

        // Cross-repo fan-out via contract links
        const crossResults: unknown[] = [];
        if (crossDepth > 0 && contexts.length > 1) {
          const groupName = repo.startsWith('@') ? repo.substring(1).split('/')[0] : '';
          const subgroup = params.subgroup as string | undefined;
          try {
            const contracts = getGroupContracts(groupName);
            if (contracts) {
              const affectedSymbols = new Set<string>();
              if (!('error' in localResult)) {
                for (const dg of Object.values((localResult as any).depth_groups ?? {})) {
                  for (const item of (dg as any).items ?? []) {
                    affectedSymbols.add(item.name);
                  }
                }
              }

              for (const link of contracts.crossLinks) {
                // #409: Check if any affected symbol matches the provider's handler function name
                const linkConsumed = (link.provider.handlerName && affectedSymbols.has(link.provider.handlerName))
                  || affectedSymbols.has(link.consumer.functionName);
                if (!linkConsumed) continue;

                const targetRepo = link.consumer.repoName;
                if (subgroup && !targetRepo.includes(subgroup)) continue;

                try {
                  const crossResult = backend.impact(
                    link.consumer.functionName,
                    'downstream',
                    targetRepo,
                    requireNumber(params, 'maxDepth', 3),
                    requireNumber(params, 'minConfidence', 0.3),
                    timeoutMs,
                    undefined,
                    undefined,
                    undefined,
                    mode as 'binary' | 'probabilistic',
                    decaySchedule as 'linear' | 'exponential' | 'logarithmic',
                  );
                  crossResults.push({ repo: targetRepo, contract: link.contractType, link, result: crossResult });
                } catch { /* skip unreachable repos */ }
              }
            }
          } catch { /* group not found or no contracts */ }
        }

        result = {
          group: groupName,
          anchor: anchor.repo.entry.name,
          local_impact: localResult,
          cross_repo: crossResults.length > 0 ? crossResults : undefined,
          cross_depth: crossDepth,
        };
      } else if (repo?.startsWith('@')) {
        // Group mode without cross-depth — just anchor
        const { contexts } = backend.resolveGroupRepos(repo);
        const anchor = contexts[0];
        result = backend.impact(
          target,
          (params.direction as 'upstream' | 'downstream') ?? 'upstream',
          anchor?.repo.entry.name,
          requireNumber(params, 'maxDepth', 5),
          requireNumber(params, 'minConfidence', 0.3),
          timeoutMs,
          targetUid,
          kind,
          filePath,
          mode as 'binary' | 'probabilistic',
          decaySchedule as 'linear' | 'exponential' | 'logarithmic',
        );
      } else {
        result = backend.impact(
          target,
          (params.direction as 'upstream' | 'downstream') ?? 'upstream',
          repo,
          requireNumber(params, 'maxDepth', 5),
          requireNumber(params, 'minConfidence', 0.3),
          timeoutMs,
          targetUid,
          kind,
          filePath,
          mode as 'binary' | 'probabilistic',
          decaySchedule as 'linear' | 'exponential' | 'logarithmic',
        );
      }

      timer.mark('traverse');
      const nextHint = '\n\nNext: use detect_changes() before committing to verify your changes match expected impact.';
      timer.mark('format');
      timer.stop();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.detect_changes': {
    name: 'astrolabe.detect_changes',
    description: 'Git-diff impact — maps changed files to affected symbols and processes.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['unstaged', 'staged', 'all'], default: 'unstaged' },
        repo: { type: 'string', description: 'Repository name' },
      },
    },
    handler: async (params) => {
      const timer = new PhaseTimer('detect_changes');
      timer.start();
      const result = backend.detectChanges((params.scope as 'unstaged' | 'staged' | 'all') ?? 'unstaged', params.repo as string);
      timer.mark('diff');
      timer.stop();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },

  'astrolabe.rename': {
    name: 'astrolabe.rename',
    description: '[PREVIEW ONLY] Graph-assisted multi-file rename preview. Does not perform actual renames.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string', description: 'Current symbol name' },
        new_name: { type: 'string', description: 'New name for the symbol' },
        file_path: { type: 'string', description: 'Limit to specific file (optional)' },
        dry_run: { type: 'boolean', description: 'Preview without modifying files', default: true },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['symbol_name', 'new_name'],
    },
    handler: async (params) => {
      // #291: Validate required params via requireString — was as string cast
      const symbolName = requireString(params, 'symbol_name');
      const newName = requireString(params, 'new_name');
      const result = backend.renameSymbol(
        symbolName, newName,
        params.file_path as string,
        (params.dry_run as boolean) ?? true,
        params.repo as string,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },

  'astrolabe.filter_by_label': {
    name: 'astrolabe.filter_by_label',
    description: 'Filter graph nodes by label type (e.g., Function, Class, Route). Returns matching nodes with id, label, name, and filePath.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Node label to filter by (e.g. "Function", "Class")' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['label'],
    },
    handler: async (params) => {
      const label = requireString(params, 'label');
      const result = backend.filterByLabel(label, params.repo as string);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },

  'astrolabe.cypher': {
    name: 'astrolabe.cypher',
    description: `Graph traversal queries over the knowledge graph. Chain-match nodes and traverse edges.

QUERY FORMAT:
{
  "query": {
    "match": { "label": "Function" },         // optional: filter start nodes by label/name/id
    "traverse": [                              // optional: chain of edge walks
      { "direction": "incoming", "type": "CALLS", "minConfidence": 0.8 },
      { "direction": "outgoing", "type": "MEMBER_OF" }
    ],
    "limit": 50                                // optional: max results (default 50)
  }
}
If match is omitted, starts from all nodes (limited to prevent OOM).

EXAMPLES:
- All classes: { query: { match: { label: "Class" } } }
- What calls validateUser: { query: { match: { name: "validateUser" }, traverse: [{ direction: "incoming", type: "CALLS" }] } }
- Call chain from auth: { query: { match: { name: "Authentication", label: "Community" }, traverse: [{ direction: "incoming", type: "MEMBER_OF" }, { direction: "outgoing", type: "CALLS" }] } }

RETURNS: { nodes: [...], edges: [...], nodeCount, edgeCount }`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'object', description: 'Traversal query object with match, traverse[], and limit' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['query'],
    },
    handler: async (params) => {
      const query = params.query as TraversalQuery;
      if (!query) throw new Error('Missing required parameter: query');
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const result = executeTraversal(graph, query);
      const nextHint = '\n\nNext: use context({name: "<symbol>"}) for 360-degree view of any result node.';
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + nextHint }] };
    },
  },

  'astrolabe.group_list': {
    name: 'astrolabe.group_list',
    description: 'List all cross-repo groups. Use this to discover monorepo/multi-service groupings.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const groups = listGroups();
      if (groups.length === 0) return { content: [{ type: 'text', text: 'No groups defined. Use `astrolabe group create <name>` from CLI to create one.' }] };
      const lines = groups.map((g) => `${g.name} (${Object.keys(g.repos).length} repos, created ${new Date(g.createdAt).toISOString()})`);
      return { content: [{ type: 'text', text: `Groups:\n${lines.join('\n')}\n\nNext: use group_status({name: "groupName"}) to check staleness.` }] };
    },
  },

  'astrolabe.group_status': {
    name: 'astrolabe.group_status',
    description: 'Check staleness and status of all repos in a cross-repo group.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Group name from group_list' } },
      required: ['name'],
    },
    handler: async (params) => {
      const name = requireString(params, 'name');
      const status = getGroupStatus(name);
      const lines = status.repos.map((r) => {
        const icon = r.stale ? '⚠ STALE' : '✓ current';
        const indexed = r.indexedAt ? new Date(r.indexedAt).toISOString() : 'never';
        return `${icon} | ${r.path} → ${r.repoName} (last indexed: ${indexed})`;
      });
      return { content: [{ type: 'text', text: `Group: ${status.name} (${status.repoCount} repos)\n${lines.join('\n')}` }] };
    },
  },

  'astrolabe.group_query': {
    name: 'astrolabe.group_query',
    description: 'Search across all repos in a cross-repo group. Fans out to each repo database.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        query: { type: 'string', description: 'Search term' },
        limit: { type: 'number', description: 'Max results per repo', default: 20 },
      },
      required: ['name', 'query'],
    },
    handler: async (params) => {
      const groupName = requireString(params, 'name');
      const query = requireString(params, 'query');
      const limit = requireNumber(params, 'limit', 20);
      const results = groupQuery(groupName, query, limit);
      if (results.length === 0) return { content: [{ type: 'text', text: 'No results or no reachable databases in the group.' }] };
      const lines = results.map((r) => {
        const repoResults = r.results.map((rr) => `  ${rr.label.padEnd(12)} ${rr.name.padEnd(30)} ${rr.filePath}`).join('\n');
        return `=== ${r.repoName} ===\n${repoResults}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
    },
  },

  'astrolabe.group_sync': {
    name: 'astrolabe.group_sync',
    description: `Extract HTTP API contracts from all repos in a group and cross-link providers to consumers.

Detects:
- Providers: Route handlers (Express, Flask, Laravel, etc.) from Route nodes
- Consumers: HTTP client calls (fetch, axios, got, request, httpClient) from Function nodes
- Cross-links: Matches consumers to providers across repo boundaries by path similarity

Results are persisted in the group config for subsequent group_contracts queries.
AFTER THIS: use group_contracts({name: "groupName"}) to inspect extracted contracts.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name from group_list' },
      },
      required: ['name'],
    },
    handler: async (params) => {
      const name = requireString(params, 'name');
      const results = syncGroupContracts(name);
      const lines = results.map((r) => {
        const icon = r.error ? '✗ ERROR' : '✓';
        return `${icon} | ${r.repoName}: ${r.providerCount} providers, ${r.consumerCount} consumers, ${r.crossLinks} cross-links${r.error ? ` (${r.error})` : ''}`;
      });
      const totalLinks = results.reduce((sum, r) => sum + r.crossLinks, 0);
      return { content: [{ type: 'text', text: `Contract sync for group "${name}":\n${lines.join('\n')}\n\nTotal cross-repo links: ${totalLinks}\n\nNext: use group_contracts({name: "${name}"}) to inspect contracts.` }] };
    },
  },

  'astrolabe.group_contracts': {
    name: 'astrolabe.group_contracts',
    description: `Inspect extracted cross-repo contracts for a group. Returns providers, consumers, and cross-links.

Call group_sync first if contracts are stale or not yet extracted.
Returns JSON with providers (method/path/handler), consumers (urlPattern/function/clientType), and crossLinks (matched pairs with confidence scores).`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name from group_list' },
      },
      required: ['name'],
    },
    handler: async (params) => {
      const name = requireString(params, 'name');
      const contracts = getGroupContracts(name);
      if (!contracts) {
        return { content: [{ type: 'text', text: `No contracts extracted for group "${name}". Run group_sync first.` }] };
      }
      const sharedLibCount = (contracts as any).sharedLibs?.length ?? 0;
      const summary = `Group: ${name}\nExtracted: ${new Date(contracts.extractedAt).toISOString()}\nProviders: ${contracts.providers.length}\nConsumers: ${contracts.consumers.length}\nCross-links: ${contracts.crossLinks.length}${sharedLibCount > 0 ? `\nShared libraries: ${sharedLibCount}` : ''}\n`;
      const nextHint = '\n\nFor full contract data, use context or query tools on specific provider/consumer symbols.';
      const payload: Record<string, unknown> = { crossLinks: contracts.crossLinks.slice(0, 50) };
      if (sharedLibCount > 0) payload.sharedLibs = (contracts as any).sharedLibs.slice(0, 20);
      return { content: [{ type: 'text', text: summary + JSON.stringify(payload, null, 2) + nextHint }] };
    },
  },

  'astrolabe.route_map': {
    name: 'astrolabe.route_map',
    description: 'Map API route handlers to their consumers. Finds orphaned routes.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repository name from list_repos' } },
      required: [],
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const routes = routeMap(graph);
      if (routes.length === 0) return { content: [{ type: 'text', text: 'No routes detected in the knowledge graph.' }] };
      const lines = routes.map((r) => {
        const icon = r.isOrphaned ? '⚠ orphan' : '  ';
        const consumers = r.consumers.length > 0 ? r.consumers.map((c) => c.name).join(', ') : 'none';
        return `${icon} | ${r.method.toUpperCase().padEnd(7)} ${r.path.padEnd(30)} → ${r.handlerName.padEnd(25)} consumers: ${consumers}`;
      });
      return { content: [{ type: 'text', text: `Route Map (${routes.length} routes):\n${lines.join('\n')}` }] };
    },
  },

  'astrolabe.tool_map': {
    name: 'astrolabe.tool_map',
    description: 'Map MCP/RPC tool definitions to their handlers and callers.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repository name from list_repos' } },
      required: [],
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const tools = toolMap(graph);
      if (tools.length === 0) return { content: [{ type: 'text', text: 'No tools detected in the knowledge graph.' }] };
      const lines = tools.map((t) => {
        const icon = t.isUnused ? '⚠ unused' : '  ';
        const callers = t.callers.length > 0 ? t.callers.map((c) => c.name).join(', ') : 'none';
        return `${icon} | ${t.toolType.padEnd(8)} ${t.toolName.padEnd(25)} → ${t.handlerName.padEnd(25)} callers: ${callers}`;
      });
      return { content: [{ type: 'text', text: `Tool Map (${tools.length} tools):\n${lines.join('\n')}` }] };
    },
  },

  'astrolabe.api_impact': {
    name: 'astrolabe.api_impact',
    description: 'Pre-change impact report for an API route handler or tool.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (function handler, route handler, etc.)' },
        repo: { type: 'string', description: 'Repository name from list_repos' },
      },
      required: ['name'],
    },
    handler: async (params) => {
      const name = requireString(params, 'name');
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const impact = await apiImpact(graph, name, ctx.entry.path);
      if (impact.length === 0) return { content: [{ type: 'text', text: `Symbol "${name}" not found.` }] };
      const lines: string[] = [];
      for (const imp of impact) {
        lines.push(`\nImpact for: ${imp.symbol}`);
        if (imp.routes.length > 0) {
          lines.push('Routes:');
          for (const r of imp.routes) {
            lines.push(`  ${r.method.toUpperCase()} ${r.path} — ${r.risk}`);
            if (r.consumers.length > 0) lines.push(`    Consumers: ${r.consumers.join(', ')}`);
          }
        }
        if (imp.tools.length > 0) {
          lines.push('Tools:');
          for (const t of imp.tools) lines.push(`  ${t.type}: ${t.name}`);
        }
        if (imp.shapeDrift.length > 0) {
          lines.push('Shape Drift:');
          for (const sd of imp.shapeDrift) lines.push(`  ${sd.severity}: ${sd.field}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },

  'astrolabe.shape_check': {
    name: 'astrolabe.shape_check',
    description: 'Detect API response shape mismatches between route handlers and consumers.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Route path (e.g., /api/users)' },
        repo: { type: 'string', description: 'Repository name from list_repos' },
      },
      required: ['path'],
    },
    handler: async (params) => {
      const path = requireString(params, 'path');
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const mismatches = await shapeCheck(graph, path, ctx.entry.path);
      if (mismatches.length === 0) return { content: [{ type: 'text', text: `No shape mismatches detected for route "${path}".` }] };
      const lines = mismatches.map((m) => `  ${m.severity.toUpperCase()}: ${m.field} — ${m.reason}`);
      return { content: [{ type: 'text', text: `Shape Check for "${path}" (${mismatches.length} issues):\n${lines.join('\n')}` }] };
    },
  },

  'astrolabe.group_impact': {
    name: 'astrolabe.group_impact',
    description: `Cross-repo impact analysis within a group. Resolves target symbol across all group members, runs local impact, then fans out via contract bridges (HTTP, gRPC, topic contracts).

Returns direct impacts (within same repo) plus cross-repo impacts discovered through contract links, with an overall risk assessment.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        target: { type: 'string', description: 'Target symbol to analyze' },
        direction: { type: 'string', enum: ['upstream', 'downstream', 'both'], default: 'both' },
        maxDepth: { type: 'number', default: 3 },
        crossDepth: { type: 'number', default: 2 },
        minConfidence: { type: 'number', default: 0.3 },
        targetUid: { type: 'string', description: 'Exact node ID for zero-ambiguity lookup (skips name resolution)' },
        kind: { type: 'string', description: 'Node label filter for disambiguation when target name is ambiguous' },
        file_path: { type: 'string', description: 'File path filter for disambiguation' },
      },
      required: ['name', 'target'],
    },
    handler: async (params) => {
      const timer = new PhaseTimer('group_impact');
      timer.start();
      const groupName = requireString(params, 'name');
      const target = requireString(params, 'target');
      const direction = (params.direction as 'upstream' | 'downstream' | 'both') ?? 'both';
      const maxDepth = requireNumber(params, 'maxDepth', 3);
      const crossDepth = requireNumber(params, 'crossDepth', 2);
      const minConfidence = requireNumber(params, 'minConfidence', 0.3);
      const targetUid = params.targetUid as string | undefined;
      const kind = params.kind as string | undefined;
      const filePath = params.file_path as string | undefined;

      // 1. Resolve the group
      const groups = listGroups();
      const group = groups.find((g) => g.name === groupName);
      if (!group) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Group '${groupName}' not found` }) }] };
      }

      // 2. Load reachable contexts for all group members
      let contexts: Array<{ repo: RepoContext; memberPath: string }>;
      try {
        ({ contexts } = backend.resolveGroupRepos(`@${groupName}`));
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `No reachable repos in group '${groupName}'` }) }] };
      }
      if (contexts.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `No reachable repos in group '${groupName}'` }) }] };
      }

      // 3. Search for target across all group members (#764: collect all matches, not first-match break)
      let anchorRepo: string | undefined;
      const reposWithTarget: string[] = [];
      for (const { repo } of contexts) {
        const graph = repo.loadGraph();
        const repoCandidates: Array<{ uid: string; name: string; kind: string; filePath: string; relevance: number }> = [];
        for (const node of graph.iterNodes()) {
          let matched = false;
          let relevance = 0;
          if (targetUid && node.id === targetUid) {
            matched = true;
            relevance = 1.0;
          } else if (!targetUid && (node.id === target || node.properties.name === target)) {
            matched = true;
            if (node.id === target) {
              relevance = 1.0;
            } else if (kind && node.label === kind) {
              relevance = 0.9;
            } else if (filePath && (node.properties.filePath ?? '').includes(filePath)) {
              relevance = 0.7;
            } else {
              relevance = 0.5;
            }
          }
          if (!matched) continue;
          if (kind && node.label !== kind) continue;
          if (filePath && !(node.properties.filePath ?? '').includes(filePath)) continue;
          repoCandidates.push({
            uid: node.id,
            name: (node.properties.name as string) ?? '',
            kind: node.label,
            filePath: node.properties.filePath ?? '',
            relevance,
          });
        }
        if (repoCandidates.length > 0) {
          if (!anchorRepo) anchorRepo = repo.entry.name;
          if (!reposWithTarget.includes(repo.entry.name)) {
            reposWithTarget.push(repo.entry.name);
          }
        }
      }

      if (!anchorRepo) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Target '${target}' not found in group '${groupName}'` }) }] };
      }

      timer.mark('resolve');

      // 4. Run impact within anchor repo (call once per direction)
      const directions: Array<'upstream' | 'downstream'> = direction === 'both'
        ? ['upstream', 'downstream']
        : [direction];

      const directResults: Record<string, ReturnType<LocalBackend['impact']>> = {};
      const affectedSymbols = new Set<string>();

      for (const dir of directions) {
        const result = backend.impact(target, dir, anchorRepo, maxDepth, minConfidence);
        directResults[dir] = result;
        // Collect affected symbol names for contract fan-out
        if (result && typeof result === 'object' && 'depth_groups' in result) {
          const dg = (result as { depth_groups: Record<string, { items: Array<{ name: string }> }> }).depth_groups;
          for (const group of Object.values(dg)) {
            for (const item of group.items) {
              affectedSymbols.add(item.name);
            }
          }
        }
      }

      timer.mark('direct_impact');

      // 5. Fan out via contracts
      const crossRepoImpacts: Array<Record<string, unknown>> = [];
      if (crossDepth > 0) {
        try {
          const contracts = getGroupContracts(groupName);
          if (contracts) {
            for (const link of contracts.crossLinks) {
              const linkConsumed = (link.provider.handlerName !== undefined && affectedSymbols.has(link.provider.handlerName))
                || affectedSymbols.has(link.consumer.functionName);
              if (!linkConsumed) continue;

              // Skip same-repo (already covered by direct analysis)
              if (link.consumer.repoName === anchorRepo && link.provider.repoName === anchorRepo) continue;

              const isProviderAffected = affectedSymbols.has(link.provider.handlerName ?? '');
              const targetRepo = isProviderAffected ? link.consumer.repoName : link.provider.repoName;
              const targetSymbol = isProviderAffected ? link.consumer.functionName : (link.provider.handlerName ?? link.provider.path);

              try {
                const crossResult = backend.impact(
                  targetSymbol,
                  'downstream',
                  targetRepo,
                  Math.min(maxDepth, crossDepth),
                  minConfidence,
                );
                crossRepoImpacts.push({
                  repo: targetRepo,
                  contractType: link.contractType,
                  confidence: link.confidence,
                  bridge: `${link.provider.repoName} → ${link.consumer.repoName} (${link.contractType})`,
                  result: crossResult,
                });
              } catch {
                // skip unreachable repos
              }
            }
          }
        } catch {
          // group contracts not available — skip cross-repo fan-out
        }
      }

      timer.mark('cross_repo');

      // 6. Risk assessment
      let directCount = 0;
      for (const result of Object.values(directResults)) {
        if (result && typeof result === 'object' && 'affected_count' in result) {
          directCount += (result as { affected_count: number }).affected_count;
        }
      }

      const crossCount = crossRepoImpacts.length;
      const riskLevel = directCount > 10 || crossCount > 3 ? 'critical'
        : directCount > 5 || crossCount > 1 ? 'high'
        : directCount > 0 || crossCount > 0 ? 'medium'
        : 'low';

      const output = {
        group: groupName,
        target,
        anchorRepo,
        reposWithTarget,
        directImpacts: direction === 'both' ? directResults : directResults[direction],
        crossRepoImpacts: crossRepoImpacts.length > 0 ? crossRepoImpacts : undefined,
        riskAssessment: {
          level: riskLevel,
          directAffectedCount: directCount,
          crossRepoBridges: crossCount,
          breakdown: {
            willBreak: directCount > 0 ? 'direct dependents at depth 1' : 'none',
            crossRepo: crossCount > 0 ? `${crossCount} cross-repo contract bridge(s) affected` : 'none',
          },
        },
      };

      timer.mark('format');
      timer.stop();
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  },

  'astrolabe.graph_algorithms': {
    name: 'astrolabe.graph_algorithms',
    description: `Run graph algorithms on the knowledge graph for architecture analysis.

Algorithms:
- pagerank: Identify the most important modules by link structure. Returns nodes sorted by PageRank score.
- betweenness: Find bridge nodes that connect different communities. High betweenness = critical dependency bottleneck.
- shortest_path: Find the dependency chain between two modules. Returns the shortest path or null.
- clone_detection: Detect structurally similar functions using Weisfeiler-Lehman graph kernels (#810). Returns clone clusters and top pairs.
- resilience: Detect single points of failure (cut vertices) and critical dependency bridges. Returns articulation points and bridge edges.
- architecture_smells: Detect architecture anti-patterns (cyclic dependencies, god modules, unstable deps, dependency meshes, cut vertices, bridge edges).

The graph is built from CALLS and IMPORTS relationships (excluding STEP_IN_PROCESS synthetic edges).`,
    inputSchema: {
      type: 'object',
      properties: {
        algorithm: { type: 'string', enum: ['pagerank', 'betweenness', 'shortest_path', 'clone_detection', 'spectral_analysis', 'resilience', 'architecture_smells'], description: 'Algorithm to run' },
        source: { type: 'string', description: 'Source node ID or name (required for shortest_path)' },
        target: { type: 'string', description: 'Target node ID or name (required for shortest_path)' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['algorithm'],
    },
    handler: async (params) => {
      const algorithm = requireString(params, 'algorithm');
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();

      // Build adjacency list from CALLS and IMPORTS edges
      const adjList = new Map<string, string[]>();
      const allNodes = new Set<string>();

      // Ensure all nodes are in the adjacency list
      for (const node of graph.iterNodes()) {
        allNodes.add(node.id);
        if (!adjList.has(node.id)) adjList.set(node.id, []);
      }

      for (const rel of graph.iterRelationships()) {
        if (rel.type === 'STEP_IN_PROCESS' || rel.type === 'MEMBER_OF' || rel.type === 'ENTRY_POINT_OF') continue;
        if (rel.type !== 'CALLS' && rel.type !== 'IMPORTS') continue;

        let targets = adjList.get(rel.sourceId);
        if (!targets) { targets = []; adjList.set(rel.sourceId, targets); }
        targets.push(rel.targetId);

        // Ensure target node has an entry too
        if (!adjList.has(rel.targetId)) adjList.set(rel.targetId, []);
      }

      if (algorithm === 'pagerank') {
        const results = pageRank(adjList);
        // Resolve node names for readability
        const named = results.slice(0, 50).map((r) => {
          const node = graph.getNode(r.nodeId);
          return {
            id: r.nodeId,
            name: node?.properties.name ?? r.nodeId,
            score: Math.round(r.score * 10000) / 10000,
          };
        });
        return { content: [{ type: 'text', text: JSON.stringify({ algorithm: 'pagerank', nodeCount: results.length, topNodes: named }, null, 2) }] };
      }

      if (algorithm === 'betweenness') {
        const results = betweennessCentrality(adjList);
        const named = results.slice(0, 50).map((r) => {
          const node = graph.getNode(r.nodeId);
          return {
            id: r.nodeId,
            name: node?.properties.name ?? r.nodeId,
            score: Math.round(r.score * 10000) / 10000,
          };
        });
        return { content: [{ type: 'text', text: JSON.stringify({ algorithm: 'betweenness', nodeCount: results.length, topNodes: named }, null, 2) }] };
      }

      if (algorithm === 'shortest_path') {
        const sourceParam = requireString(params, 'source');
        const targetParam = requireString(params, 'target');

        // Resolve source/target names to IDs
        let sourceId = sourceParam;
        let targetId = targetParam;
        for (const node of graph.iterNodes()) {
          if (node.properties.name === sourceParam || node.id === sourceParam) sourceId = node.id;
          if (node.properties.name === targetParam || node.id === targetParam) targetId = node.id;
        }

        const path = shortestPath(adjList, sourceId, targetId);

        if (!path) {
          return { content: [{ type: 'text', text: JSON.stringify({ algorithm: 'shortest_path', source: sourceParam, target: targetParam, path: null, message: 'No path found between the specified nodes.' }) }] };
        }

        const namedPath = path.map((id) => {
          const node = graph.getNode(id);
          return node?.properties.name ?? id;
        });

        return { content: [{ type: 'text', text: JSON.stringify({ algorithm: 'shortest_path', source: sourceParam, target: targetParam, path: namedPath, length: path.length - 1 }, null, 2) }] };
      }

      if (algorithm === 'clone_detection') {
        // Build adjacency limited to Function/Method nodes for meaningful clone detection
        const FUNCTION_LABELS = new Set(['Function', 'Method']);
        const functionNodes = new Set<string>();
        const cloneAdj = new Map<string, string[]>();
        const nodeNames = new Map<string, string>();
        for (const node of graph.iterNodes()) {
          if (!FUNCTION_LABELS.has(node.label)) continue;
          functionNodes.add(node.id);
          cloneAdj.set(node.id, []);
          nodeNames.set(node.id, (node.properties.name as string) ?? node.id);
        }
        for (const rel of graph.iterRelationships()) {
          if (rel.type !== 'CALLS' && rel.type !== 'IMPORTS') continue;
          if (!functionNodes.has(rel.sourceId) || !functionNodes.has(rel.targetId)) continue;
          let targets = cloneAdj.get(rel.sourceId);
          if (!targets) { targets = []; cloneAdj.set(rel.sourceId, targets); }
          targets.push(rel.targetId);
        }

        const result = detectClones(cloneAdj, nodeNames);

        // Format output
        const output = {
          algorithm: 'clone_detection',
          totalFunctions: result.totalFunctions,
          clonePairs: result.topPairs.map((p) => ({
            functionA: p.functionA.name,
            functionB: p.functionB.name,
            similarity: Math.round(p.similarity * 100) / 100,
          })),
          clusters: result.clusters.map((c) => ({
            id: c.clusterId,
            size: c.memberCount,
            representative: c.representativeFunction,
            members: c.members.map((m) => m.name),
          })),
          summary: result.summary,
          method: 'Weisfeiler-Lehman graph kernel (2 iterations)',
        };

        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
      }

      if (algorithm === 'spectral_analysis') {
        // Build optional community map from Community nodes + MEMBER_OF edges
        const communityMap = new Map<string, string[]>();
        for (const node of graph.iterNodes()) {
          if (node.label === 'Community') {
            communityMap.set(
              (node.properties.name as string) ?? node.id,
              [],
            );
          }
        }
        for (const rel of graph.iterRelationships()) {
          if (rel.type === 'MEMBER_OF') {
            const commNode = graph.getNode(rel.targetId);
            if (commNode && commNode.label === 'Community') {
              const name = (commNode.properties.name as string) ?? commNode.id;
              let members = communityMap.get(name);
              if (!members) { members = []; communityMap.set(name, members); }
              members.push(rel.sourceId);
            }
          }
        }

        const metrics = computeSpectralMetrics(adjList, communityMap.size > 0 ? communityMap : undefined);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              algorithm: 'spectral_analysis',
              metrics: {
                nodeCount: metrics.nodeCount,
                edgeCount: metrics.edgeCount,
                density: Math.round(metrics.density * 10000) / 10000,
                degreeEntropy: Math.round(metrics.degreeEntropy * 1000) / 1000,
                avgDegree: Math.round(metrics.avgDegree * 100) / 100,
                maxDegree: metrics.maxDegree,
                flowHierarchy: Math.round(metrics.flowHierarchy * 10000) / 10000,
                modularityQ: Math.round(metrics.modularityQ * 10000) / 10000,
                topology: metrics.topologyType,
                topologyConfidence: Math.round(metrics.topologyConfidence * 100) / 100,
              },
              interpretation: {
                density: metrics.density < 0.1 ? 'Sparse graph — loosely coupled architecture' : metrics.density > 0.3 ? 'Dense graph — tightly coupled architecture' : 'Moderately connected',
                degreeEntropy: metrics.degreeEntropy < 1 ? 'Uniform degree distribution' : metrics.degreeEntropy > 3 ? 'Highly skewed degree distribution (hub-centric)' : 'Moderately diverse degrees',
                flowHierarchy: metrics.flowHierarchy > 0.7 ? 'Highly hierarchical — clear dependency direction' : metrics.flowHierarchy < 0.3 ? 'Cyclic — strong bidirectional coupling' : 'Mixed hierarchy',
                modularityQ: metrics.modularityQ > 0.5 ? 'Well-modularized' : metrics.modularityQ > 0.3 ? 'Moderately modular' : 'Low modularity',
              },
            }, null, 2),
          }],
        };
      }

      if (algorithm === 'resilience') {
        const cutVertices = detectCutVertices(adjList);
        const bridges = detectBridges(adjList);

        // Resolve node names for readability (staging API: CutVertexResult.nodeId, BridgeResult.sourceId/targetId)
        const namedCutVertices = cutVertices.map((cv) => {
          const node = graph.getNode(cv.nodeId);
          return { id: cv.nodeId, name: node?.properties.name ?? cv.nodeId };
        });

        const namedBridges = bridges.map((b) => {
          const srcNode = graph.getNode(b.sourceId);
          const tgtNode = graph.getNode(b.targetId);
          return {
            source: { id: b.sourceId, name: srcNode?.properties.name ?? b.sourceId },
            target: { id: b.targetId, name: tgtNode?.properties.name ?? b.targetId },
          };
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              algorithm: 'resilience',
              analysis: {
                cutVertices: {
                  count: cutVertices.length,
                  nodes: namedCutVertices,
                  description: 'Nodes whose removal disconnects the graph (single points of failure)',
                },
                bridgeEdges: {
                  count: bridges.length,
                  edges: namedBridges,
                  description: 'Edges whose removal disconnects the graph (critical dependency links)',
                },
                robustnessSummary: cutVertices.length === 0 && bridges.length === 0
                  ? 'The graph is biconnected — no single point of failure detected.'
                  : `Found ${cutVertices.length} cut vertices (SPoF) and ${bridges.length} bridge edges.`,
              },
            }, null, 2),
          }],
        };
      }

      if (algorithm === 'architecture_smells') {
        const results = architectureSmells(adjList);
        const output: any = {
          algorithm: 'architecture_smells',
          summary: {
            cycles: results.sccs?.length ?? 0,
            cutVertices: results.cutVertices?.length ?? 0,
            bridges: results.bridges?.length ?? 0,
            hubs: results.hubs?.length ?? 0,
            meshes: results.meshes?.length ?? 0,
          },
        };
        if (results.sccs?.length) output.sccs = results.sccs;
        if (results.hubs?.length) output.hubs = results.hubs;
        if (results.martinMetrics?.length) output.martinMetrics = results.martinMetrics;
        if (results.meshes?.length) output.meshes = results.meshes;
        if (results.cutVertices?.length) output.cutVertices = results.cutVertices;
        if (results.bridges?.length) output.bridges = results.bridges;
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown algorithm: ${algorithm}` }) }] };
    },
  },

  'astrolabe.grep': {
    name: 'astrolabe.grep',
    description: `Regex search across file contents in the indexed repository. Returns matching lines with file path and line number.

ReDoS protection: pattern max 200 chars. Results capped at 50 by default (max 200).`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for (max 200 chars)' },
        repo: { type: 'string', description: 'Repository name' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)', default: 50 },
      },
      required: ['pattern'],
    },
    handler: async (params) => {
      const pattern = requireString(params, 'pattern');
      if (pattern.length > 200) throw new Error('Pattern too long (max 200 characters)');

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'gim');
      } catch {
        throw new Error('Invalid regex pattern');
      }

      const limit = Math.max(1, Math.min(200, requireNumber(params, 'limit', 50)));
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const repoRoot = ctx.entry.path;
      const results: Array<{ filePath: string; line: number; text: string }> = [];

      // Collect indexed file paths from graph
      const indexedFiles = new Set<string>();
      for (const node of graph.iterNodes()) {
        if (node.label === 'File' && node.properties.filePath) {
          indexedFiles.add(node.properties.filePath as string);
        }
      }

      // Search files on disk one at a time (constant memory)
      for (const filePath of indexedFiles) {
        if (results.length >= limit) break;
        const fullPath = pathJoin(repoRoot, filePath);

        // Path traversal guard
        if (!fullPath.startsWith(repoRoot)) continue;
        if (!existsSync(fullPath)) continue;

        let content: string;
        try {
          content = readFileSync(fullPath, 'utf-8');
        } catch {
          continue; // File may have been deleted since indexing
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= limit) break;
          if (regex.test(lines[i])) {
            results.push({ filePath, line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
          regex.lastIndex = 0;
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ matches: results.length, results }, null, 2) }] };
    },
  },

  'astrolabe.chat': {
    name: 'astrolabe.chat',
    description: `Conversational AI assistant grounded in the knowledge graph. Ask questions about the codebase in natural language.

Uses RAG (Retrieval-Augmented Generation): retrieves relevant symbols from the graph, then generates a grounded answer via an OpenAI-compatible LLM.

Requires ASTROLABE_API_KEY or OPENAI_API_KEY environment variable to be set for the MCP server process.`,
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Your question about the codebase' },
        repo: { type: 'string', description: 'Repository name (omit if only one indexed)' },
        history: { type: 'array', description: 'Previous conversation messages [{role: "user"|"assistant", content: "..."}]', items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } }, required: ['role', 'content'] } },
      },
      required: ['message'],
    },
    handler: async (params) => {
      const message = requireString(params, 'message');
      const repo = params.repo as string | undefined;
      const history = (params.history as Array<{ role: string; content: string }>) ?? [];

      // Build conversation messages
      const messages: ChatMessage[] = history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      messages.push({ role: 'user', content: message });

      try {
        const result = await ragChat(messages, { repo });
        const sourceLines = result.sources.length > 0
          ? '\n\nSources:\n' + result.sources.slice(0, 10).map((s, i) => `${i + 1}. ${s.name} (${s.type}) — ${s.filePath}`).join('\n')
          : '';
        return { content: [{ type: 'text', text: result.content + sourceLines }] };
      } catch (err: any) {
        if (err.message?.includes('No API key')) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
        throw err;
      }
    },
  },

  'astrolabe.generate_diagram': {
    name: 'astrolabe.generate_diagram',
    description: `Generate Mermaid architecture diagrams from the knowledge graph.

DIAGRAM TYPES:
- community: Cluster subgraphs showing module boundaries, member symbols, and coupling edges
- process: Execution flow diagrams from entry points through step-by-step call traces
- dependency: Directed graph of CALLS, IMPORTS, EXTENDS, IMPLEMENTS, USES relationships
- class_hierarchy: Inheritance tree showing EXTENDS/IMPLEMENTS between classes and interfaces`,
    inputSchema: {
      type: 'object',
      properties: {
        diagram_type: { type: 'string', enum: ['community', 'process', 'dependency', 'class_hierarchy'], description: 'Type of diagram to generate' },
        repo: { type: 'string', description: 'Repository name' },
        cluster_id: { type: 'string', description: 'Filter community diagram to a specific cluster (by id or name)' },
        process_id: { type: 'string', description: 'Filter process diagram to a specific process (by id or name)' },
        format: { type: 'string', enum: ['mermaid', 'markdown'], description: 'Output format. "mermaid" returns raw diagram code. "markdown" wraps in documentation.', default: 'mermaid' },
        max_nodes: { type: 'number', description: 'Maximum nodes to include (default: 200 for community, 100 for others)' },
        min_confidence: { type: 'number', description: 'Minimum edge confidence threshold (default: 0.5)' },
      },
      required: ['diagram_type'],
    },
    handler: async (params) => {
      const diagramType = requireString(params, 'diagram_type') as DiagramType;
      const format = (params.format as string) ?? 'mermaid';
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();

      const opts: DiagramOptions = {
        type: diagramType,
        clusterId: params.cluster_id as string | undefined,
        processId: params.process_id as string | undefined,
        maxNodes: params.max_nodes as number | undefined,
        minConfidence: params.min_confidence as number | undefined,
      };

      if (format === 'markdown') {
        const repoName = (params.repo as string) ?? ctx.entry.name;
        const doc = generateMarkdownDoc(graph, opts, repoName);
        return { content: [{ type: 'text', text: doc }] };
      }

      const result = generateDiagram(graph, opts);
      const statsLine = `// ${result.stats.nodeCount} nodes, ${result.stats.edgeCount} edges`;
      return { content: [{ type: 'text', text: result.diagram + '\n\n' + statsLine }] };
    },
  },

  'astrolabe.analyze_architecture': {
    name: 'astrolabe.analyze_architecture',
    description: `Analyze architectural patterns using graphlet-based structural analysis. Detects hub-and-spoke, chain, diamond, and cycle motifs. Maps to architectural patterns (layered, microservices, event-driven, MVC) and scores overall health.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        include_health: { type: 'boolean', description: 'Include architecture health scoring (default: true)' },
      },
    },
    handler: async (params) => {
      const timer = new PhaseTimer('analyze_architecture');
      timer.start();

      // 1. Load graph
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();

      // 2. Collect non-structural node IDs (exclude File, Folder, Import, Package)
      const structuralLabels = new Set(['File', 'Folder', 'Import', 'Package']);
      const nodeIds = new Set<string>();
      const nodeIterable: Array<{ id: string }> = [];
      for (const node of graph.iterNodes()) {
        if (!structuralLabels.has(node.label)) {
          nodeIds.add(node.id);
          nodeIterable.push({ id: node.id });
        }
      }

      // 3. Build adjacency map from CALLS, IMPORTS, EXTENDS edges only
      const allowedEdgeTypes = new Set(['CALLS', 'IMPORTS', 'EXTENDS']);
      const relIterable: Array<{ sourceId: string; targetId: string; type: string }> = [];
      for (const rel of graph.iterRelationships()) {
        if (allowedEdgeTypes.has(rel.type)) {
          relIterable.push({ sourceId: rel.sourceId, targetId: rel.targetId, type: rel.type });
        }
      }
      const adjMap = buildAdjacencyMap(relIterable, nodeIds);

      timer.mark('build_adjacency');

      // 4. Count graphlets
      const profile = countGraphlets(nodeIterable, adjMap);

      timer.mark('count_graphlets');

      // 5. Detect patterns
      const patterns = detectPatterns(profile);

      timer.mark('detect_patterns');

      // 6. Optionally score health
      let health: ReturnType<typeof scoreArchitectureHealth> | undefined;
      const includeHealth = params.include_health !== false; // default true
      if (includeHealth) {
        // Extract community info from graph
        const communities: CommunityInfo[] = [];
        const communityNodes = graph.findNodesByLabel('Community');
        for (const cNode of communityNodes) {
          const memberCount = cNode.properties.symbolCount as number | undefined;
          if (memberCount !== undefined && memberCount > 0) {
            communities.push({ id: cNode.id, nodeCount: memberCount });
          }
        }
        health = scoreArchitectureHealth(profile, communities, adjMap);
        timer.mark('health_score');
      }

      timer.stop();

      const output = {
        graphletProfile: {
          motif3: profile.motif3,
          motif4: profile.motif4,
          nodeCount: profile.nodeCount,
          edgeCount: profile.edgeCount,
          sampled: profile.sampled,
          sampleSize: profile.sampleSize,
        },
        patterns: patterns.map((p) => ({
          name: p.name,
          confidence: Math.round(p.confidence * 100) / 100,
          description: p.description,
          indicators: p.indicators,
        })),
        health: health ? {
          overallScore: health.overallScore,
          cohesion: health.cohesion,
          modularity: health.modularity,
          complexity: health.complexity,
          antiPatterns: health.antiPatterns,
        } : undefined,
      };

      const nextHint = '\n\nNext: use graph_algorithms({algorithm: "pagerank"}) to identify the most important modules, or cypher({query: {...}}) to explore specific dependency patterns.';
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) + nextHint }] };
    },
  },

  // #872: Design pattern detection results
  'astrolabe.patterns': {
    name: 'astrolabe.patterns',
    description: `List detected design patterns in the codebase. Shows which GoF patterns (creational, structural, behavioral) and language idioms are present, with confidence scores and file locations. Use to understand architectural decisions and pattern usage.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name (optional if only one indexed)' },
        category: { type: 'string', description: 'Filter by category: gof-creational, gof-structural, gof-behavioral, idiom' },
        min_confidence: { type: 'number', description: 'Minimum confidence threshold 0-1 (default: 0.5)' },
      },
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string | undefined);
      const graph = ctx.loadGraph();

      const category = params.category as string | undefined;
      const minConfidence = requireNumber(params, 'min_confidence', 0.5);

      // Find all PatternInstance nodes
      const patternNodes = graph.findNodesByLabel('PatternInstance');
      const filtered = patternNodes.filter((n) => {
        if (category && n.properties.category !== category) return false;
        if ((n.properties.confidence as number) < minConfidence) return false;
        return true;
      });

      // Group by pattern ID
      const byPattern = new Map<string, Array<{ name: string; filePath: string; startLine: number; endLine: number; confidence: number; captures: Record<string, string> }>>();
      for (const n of filtered) {
        const pid = n.properties.patternId as string;
        if (!byPattern.has(pid)) byPattern.set(pid, []);
        byPattern.get(pid)!.push({
          name: n.properties.name as string,
          filePath: n.properties.filePath as string,
          startLine: n.properties.startLine as number,
          endLine: n.properties.endLine as number,
          confidence: n.properties.confidence as number,
          captures: n.properties.captures as Record<string, string>,
        });
      }

      // Category summary from node properties
      const categorySummary: Record<string, number> = {};
      for (const n of filtered) {
        const cat = n.properties.category as string;
        categorySummary[cat] = (categorySummary[cat] ?? 0) + 1;
      }

      const output = {
        totalPatterns: filtered.length,
        uniquePatternTypes: byPattern.size,
        byCategory: categorySummary,
        patterns: Object.fromEntries(
          Array.from(byPattern.entries()).map(([pid, instances]) => [
            pid,
            { count: instances.length, instances: instances.map((i) => ({ ...i, confidence: Math.round(i.confidence * 100) / 100 })) },
          ]),
        ),
      };

      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  },

  // #464: Security audit tool
  'astrolabe.security_audit': {
    name: 'astrolabe.security_audit',
    description: `Run a security audit on an indexed repository. Detects secrets in code, identifies security-sensitive code patterns, and optionally checks dependencies for known vulnerabilities via OSV.dev.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name (optional if only one indexed)' },
        check_deps: { type: 'boolean', description: 'Check dependencies for vulnerabilities via OSV.dev (default: false)' },
        severity_threshold: { type: 'string', description: 'Minimum severity to report: critical, high, medium, low (default: low)', enum: ['critical', 'high', 'medium', 'low'] },
      },
    },
    handler: async (params) => {
      const repo = params.repo as string | undefined;
      const checkDeps = (params.check_deps as boolean) ?? false;
      const severityThreshold = (params.severity_threshold as string) ?? 'low';

      // #464: Load graph from DB
      const ctx = backend.getRepo(repo);
      const graph = ctx.loadGraph();

      // #464: Import security patterns and scan logic inline to avoid circular deps
      const SECRET_PATTERNS = [
        { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/g, severity: 'critical' },
        { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"][A-Za-z0-9/+=]{40}['"]/gi, severity: 'critical' },
        { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, severity: 'critical' },
        { name: 'GitHub OAuth', pattern: /gho_[A-Za-z0-9]{36}/g, severity: 'critical' },
        { name: 'Slack Token', pattern: /xox[baprs]-[0-9]{10,}-[A-Za-z0-9]+/g, severity: 'high' },
        { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, severity: 'critical' },
        { name: 'JWT', pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, severity: 'medium' },
        { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"][A-Za-z0-9]{20,}['"]/gi, severity: 'high' },
        { name: 'Generic Secret', pattern: /(?:secret|password|token)\s*[=:]\s*['"][A-Za-z0-9!@#$%^&*]{16,}['"]/gi, severity: 'high' },
        { name: 'Google API Key', pattern: /AIza[0-9A-Za-z_-]{35}/g, severity: 'high' },
        { name: 'Stripe Key', pattern: /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{24,}/g, severity: 'critical' },
      ];

      const SECURITY_PATTERNS = [
        { category: 'auth', patterns: [/\b(?:login|authenticate|authorize|logout|session)\b/i], severity: 'medium' },
        { category: 'crypto', patterns: [/\b(?:encrypt|decrypt|hash|sign|verify|cipher|digest)\b/i], severity: 'medium' },
        { category: 'sql', patterns: [/\b(?:executeQuery|rawQuery|\.query\(|sql.*\+|SELECT.*FROM|INSERT.*INTO)\b/i], severity: 'high' },
        { category: 'file-io', patterns: [/\b(?:readFile|writeFile|unlink|rmdir|exec|spawn)\b/i], severity: 'low' },
        { category: 'network', patterns: [/\b(?:fetch|axios|http\.request|XMLHttpRequest|websocket)\b/i], severity: 'info' },
      ];

      const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      const meetsThreshold = (sev: string) => (SEVERITY_ORDER[sev] ?? 4) <= (SEVERITY_ORDER[severityThreshold] ?? 4);

      const findings: Array<Record<string, unknown>> = [];
      let secretCount = 0;
      let securityPatternCount = 0;

      // #464: Scan all nodes
      const binaryExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'zip', 'gz', 'tar', 'wasm']);

      for (const node of graph.iterNodes()) {
        const content = typeof node.properties.content === 'string' ? node.properties.content : '';
        const name = typeof node.properties.name === 'string' ? node.properties.name : '';
        const filePath = typeof node.properties.filePath === 'string' ? node.properties.filePath : '';
        if (!filePath) continue;

        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        if (binaryExtensions.has(ext)) continue;

        // #464: Secret scanning
        if (content) {
          for (const { name: patternName, pattern, severity } of SECRET_PATTERNS) {
            if (!meetsThreshold(severity)) continue;
            const regex = new RegExp(pattern.source, pattern.flags);
            if (regex.test(content)) {
              secretCount++;
              findings.push({
                type: 'secret',
                severity,
                category: patternName,
                message: `Detected ${patternName} in ${node.label} "${name || node.id}"`,
                nodeId: node.id,
                filePath,
              });
            }
          }
        }

        // #464: Security pattern scanning
        const textToScan = [name, content].filter(Boolean).join(' ');
        if (textToScan) {
          for (const { category, patterns, severity } of SECURITY_PATTERNS) {
            if (!meetsThreshold(severity)) continue;
            for (const pat of patterns) {
              const regex = new RegExp(pat.source, pat.flags);
              if (regex.test(textToScan)) {
                securityPatternCount++;
                findings.push({
                  type: 'security-pattern',
                  severity,
                  category,
                  message: `Security-sensitive ${category} pattern in ${node.label} "${name || node.id}"`,
                  nodeId: node.id,
                  filePath,
                });
                break;
              }
            }
          }
        }
      }

      // #464: Optionally check dependencies
      let vulnerabilityReport: Record<string, unknown> | null = null;
      if (checkDeps) {
        try {
          const { detectManifestFiles, parseManifest, checkVulnerabilities } = await import('../analysis/security/vulnerabilities.js');
          const repoPath = ctx.entry.path;
          const manifests = detectManifestFiles(repoPath);
          const allDeps: Array<{ name: string; version: string; ecosystem: string }> = [];
          for (const m of manifests) {
            const deps = parseManifest(m.path, m.ecosystem);
            allDeps.push(...deps);
          }
          if (allDeps.length > 0) {
            vulnerabilityReport = await checkVulnerabilities(allDeps) as unknown as Record<string, unknown>;
          }
        } catch (err) {
          vulnerabilityReport = { error: `Dependency check failed: ${String(err)}` };
        }
      }

      const report = {
        findings,
        summary: {
          totalFindings: findings.length,
          secretCount,
          securityPatternCount,
        },
        vulnerabilities: vulnerabilityReport,
      };

      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    },
  },

  // #463: Coverage report summary
  'astrolabe.coverage_report': {
    name: 'astrolabe.coverage_report',
    description: `Show test coverage summary for an indexed repository, grouped by community/module. Requires coverage data to have been ingested via the ingest-coverage CLI command.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        group_by: { type: 'string', description: 'Group results by: file, community, label', enum: ['file', 'community', 'label'] },
      },
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const groupBy = (params.group_by as string) ?? 'file';

      // Collect all nodes with coverage annotations
      interface CoverageEntry { name: string; label: string; filePath: string; lineCoverage: number; functionCoverage: number; status: string; community?: string }
      const entries: CoverageEntry[] = [];

      // Build community index for grouping
      const communityOf = new Map<string, string>();
      for (const rel of graph.iterRelationships()) {
        if (rel.type === 'MEMBER_OF') {
          const communityNode = graph.getNode(rel.targetId);
          if (communityNode && communityNode.label === 'Community') {
            communityOf.set(rel.sourceId, (communityNode.properties.name as string) ?? communityNode.id);
          }
        }
      }

      for (const node of graph.iterNodes()) {
        const cov = node.properties._coverage as { lineCoverage: number; functionCoverage: number } | undefined;
        if (!cov) continue;

        entries.push({
          name: (node.properties.name as string) ?? node.id,
          label: node.label,
          filePath: (node.properties.filePath as string) ?? '',
          lineCoverage: cov.lineCoverage,
          functionCoverage: cov.functionCoverage,
          status: (node.properties._coverageStatus as string) ?? 'unknown',
          community: communityOf.get(node.id),
        });
      }

      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No coverage data found. Run `astrolabe ingest-coverage <report-file>` first.' }] };
      }

      // Group results
      const groups = new Map<string, CoverageEntry[]>();
      for (const entry of entries) {
        let key: string;
        if (groupBy === 'community') key = entry.community ?? '(unassigned)';
        else if (groupBy === 'label') key = entry.label;
        else key = entry.filePath || '(unknown file)';

        let bucket = groups.get(key);
        if (!bucket) { bucket = []; groups.set(key, bucket); }
        bucket.push(entry);
      }

      // Build output
      const overallLineCov = entries.length > 0
        ? entries.reduce((s, e) => s + e.lineCoverage, 0) / entries.length
        : 0;
      const lines: string[] = [
        `Coverage Summary (${entries.length} entries, grouped by ${groupBy})`,
        `Overall average line coverage: ${overallLineCov.toFixed(1)}%`,
        '',
      ];

      const uncovered = entries.filter((e) => e.status === 'uncovered').length;
      const partial = entries.filter((e) => e.status === 'partial').length;
      const covered = entries.filter((e) => e.status === 'covered').length;
      lines.push(`Status: ${covered} covered, ${partial} partial, ${uncovered} uncovered`);
      lines.push('');

      for (const [group, items] of groups) {
        const avgLine = items.reduce((s, e) => s + e.lineCoverage, 0) / items.length;
        const avgFn = items.reduce((s, e) => s + e.functionCoverage, 0) / items.length;
        lines.push(`## ${group} (${items.length} items, avg line: ${avgLine.toFixed(1)}%, avg fn: ${avgFn.toFixed(1)}%)`);
        for (const item of items.slice(0, 20)) {
          const icon = item.status === 'covered' ? '✓' : item.status === 'partial' ? '◐' : '✗';
          lines.push(`  ${icon} ${item.label}:${item.name} — line ${item.lineCoverage.toFixed(0)}%, fn ${item.functionCoverage.toFixed(0)}%`);
        }
        if (items.length > 20) lines.push(`  ... and ${items.length - 20} more`);
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },

  // #463: Coverage gaps — high-impact uncovered symbols
  'astrolabe.coverage_gaps': {
    name: 'astrolabe.coverage_gaps',
    description: `Find symbols with high impact score but zero test coverage. These are the riskiest untested parts of the codebase.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        min_impact: { type: 'number', description: 'Minimum impact score (incoming edges) to consider' },
      },
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const minImpact = (params.min_impact as number) ?? 2;

      // Count incoming edges per node
      const incomingCount = new Map<string, number>();
      for (const rel of graph.iterRelationships()) {
        incomingCount.set(rel.targetId, (incomingCount.get(rel.targetId) ?? 0) + 1);
      }

      // Find uncovered nodes with high impact
      interface GapEntry { name: string; label: string; filePath: string; startLine: number; incomingEdges: number }
      const gaps: GapEntry[] = [];

      for (const node of graph.iterNodes()) {
        const status = node.properties._coverageStatus as string | undefined;
        if (status !== 'uncovered') continue;

        const impact = incomingCount.get(node.id) ?? 0;
        if (impact < minImpact) continue;

        gaps.push({
          name: (node.properties.name as string) ?? node.id,
          label: node.label,
          filePath: (node.properties.filePath as string) ?? '',
          startLine: (node.properties.startLine as number) ?? 0,
          incomingEdges: impact,
        });
      }

      // Sort by impact (highest first)
      gaps.sort((a, b) => b.incomingEdges - a.incomingEdges);

      if (gaps.length === 0) {
        return { content: [{ type: 'text', text: `No uncovered symbols with >= ${minImpact} incoming edges found. Either no coverage data ingested or all high-impact code is covered.` }] };
      }

      const lines: string[] = [
        `Coverage Gaps: ${gaps.length} uncovered symbols with >= ${minImpact} incoming edges`,
        '',
      ];

      for (const gap of gaps.slice(0, 50)) {
        lines.push(`  ⚠ ${gap.label}:${gap.name} — ${gap.incomingEdges} dependents (${gap.filePath}:${gap.startLine})`);
      }
      if (gaps.length > 50) lines.push(`  ... and ${gaps.length - 50} more`);

      lines.push('');
      lines.push('These symbols have no test coverage but are depended upon by multiple callers. Consider adding tests to reduce risk.');

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },

  // #811: Graph-based test coverage analysis
  'astrolabe.test_coverage': {
    name: 'astrolabe.test_coverage',
    description: `Analyze test coverage using graph structure — per-community metrics, edge coverage, and gap prioritization. Requires coverage data to have been ingested via the ingest-coverage CLI command.

Returns:
- Overall node/edge coverage percentages
- Per-community breakdown with top coverage gaps
- Top untested high-impact symbols for prioritization`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
      },
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();
      const metrics = computeGraphCoverageMetrics(graph);

      if (metrics.totalFunctionNodes === 0) {
        return { content: [{ type: 'text', text: 'No function nodes found in the knowledge graph. Run `astrolabe analyze` first.' }] };
      }

      // Build text output
      const lines: string[] = [
        `=== Test Coverage Analysis (Graph-Aware) ===`,
        '',
        `Overall: ${metrics.overallNodeCoveragePercent.toFixed(1)}% node coverage (${metrics.coveredFunctionNodes} covered / ${metrics.partialFunctionNodes} partial / ${metrics.uncoveredFunctionNodes} uncovered of ${metrics.totalFunctionNodes} total)`,
        `Calls edges: ${metrics.overallEdgeCoveragePercent.toFixed(1)}% edge coverage (${metrics.coveredCallEdges} covered / ${metrics.totalCallEdges} total)`,
        '',
      ];

      // Per-community breakdown
      lines.push(`--- Per-Community Coverage (${metrics.communities.length} communities) ---`);
      for (const c of metrics.communities) {
        const bar = '█'.repeat(Math.round(c.nodeCoveragePercent / 10)) + '░'.repeat(10 - Math.round(c.nodeCoveragePercent / 10));
        lines.push(`  ${c.communityName}: ${bar} ${c.nodeCoveragePercent.toFixed(0)}% nodes, ${c.edgeCoveragePercent.toFixed(0)}% edges`);
        for (const gap of c.topGaps) {
          lines.push(`    ⚠ ${gap.label}:${gap.name} (impact: ${gap.impact})`);
        }
      }

      // Top gaps
      if (metrics.topUntestedHighImpact.length > 0) {
        lines.push('');
        lines.push('--- Top 20 Untested High-Impact Symbols ---');
        for (const gap of metrics.topUntestedHighImpact) {
          lines.push(`  ⚠ [${gap.community}] ${gap.label}:${gap.name} — ${gap.impact} dependents (${gap.filePath})`);
        }
        lines.push('');
        lines.push('These symbols have no test coverage but are heavily depended upon. Prioritize adding tests for them.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },

  // #809: GNN node classification feature engineering and dataset export
  'astrolabe.gnn_export': {
    name: 'astrolabe.gnn_export',
    description: `Export GNN-ready feature vectors and dataset from the knowledge graph for graph neural network training (#809).

Feature vectors include:
- Node features: one-hot label encoding (37 labels), degree in/out, PageRank, betweenness centrality, community ID, code metrics (param count, async, static, abstract, lines, nesting)
- Edge features: one-hot type encoding (26 types), confidence score, cross-community flag
- Optional: 384-D embedding vectors from the SQLite embedding store

Writes nodes.csv (or .json), edges.csv (or .json), node_labels.json, and edge_types.json to the specified output directory.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        output_path: { type: 'string', description: 'Output directory path for exported files (default: .astrolabe/gnn-dataset/)' },
        format: { type: 'string', description: 'Output format: csv or json (default: csv)' },
        include_embeddings: { type: 'boolean', description: 'Include 384-D embedding vectors in node features (default: false)' },
      },
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string);
      const graph = ctx.loadGraph();

      const outputPath = (params.output_path as string) || '.astrolabe/gnn-dataset/';
      const format = ((params.format === 'json' ? 'json' : 'csv') as 'csv' | 'json');
      const includeEmbeddings = params.include_embeddings === true;

      const result = exportGnnDataset(graph, outputPath, {
        dbPath: ctx.entry.dbPath,
        format,
        includeEmbeddings,
      });

      const lines = [
        `GNN dataset exported to: ${result.exportPath}`,
        `  Nodes: ${result.nodeCount.toLocaleString()}`,
        `  Edges: ${result.edgeCount.toLocaleString()}`,
        `  Feature dimensions: ${result.featureDimensions}`,
        `  Format: ${format}`,
        `  Embeddings: ${includeEmbeddings ? 'included' : 'not included'}`,
        '',
        `Output files:`,
        `  ${pathJoin(outputPath, format === 'json' ? 'nodes.json' : 'nodes.csv')}`,
        `  ${pathJoin(outputPath, format === 'json' ? 'edges.json' : 'edges.csv')}`,
        `  ${pathJoin(outputPath, 'node_labels.json')}`,
        `  ${pathJoin(outputPath, 'edge_types.json')}`,
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },

  // #807: Temporal graph evolution — snapshots, diffs, and trend detection
  'astrolabe.graph_evolution': {
    name: 'astrolabe.graph_evolution',
    description: `Temporal graph evolution — view snapshots of architecture health over time, detect improving/degrading trends, and diff any two snapshots.

Returns snapshots filtered by date range, a trend summary (health direction, slope, confidence), and per-metric summaries.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name (omit if only one indexed)' },
        since: { type: 'string', description: 'ISO 8601 start date for snapshot range (optional)' },
        until: { type: 'string', description: 'ISO 8601 end date for snapshot range (optional)' },
      },
      required: [],
    },
    handler: async (params) => {
      const ctx = backend.getRepo(params.repo as string);
      const store = ctx.store;

      const since = params.since as string | undefined;
      const until = params.until as string | undefined;

      const snapshots = store.loadSnapshots(since, until);
      const trend = detectTrends(snapshots);

      // Detect cohesion/coupling trend if enough snapshots
      let couplingDirection: string = 'stable';
      if (snapshots.length >= 2) {
        const firstCohesion = snapshots[0].cohesion;
        const lastCohesion = snapshots[snapshots.length - 1].cohesion;
        const cohesionDelta = lastCohesion - firstCohesion;
        couplingDirection = cohesionDelta > 0.05 ? 'decoupling' : cohesionDelta < -0.05 ? 'tightening' : 'stable';
      }

      // Build trend summary
      const trendSummary = {
        health: {
          direction: trend.direction,
          slope: trend.slope,
          confidence: trend.confidence,
        },
        coupling: {
          direction: couplingDirection,
        },
        communities: snapshots.length > 0 ? snapshots[snapshots.length - 1].communityCount : 0,
      };

      const output = {
        repo: ctx.entry.name,
        snapshotCount: snapshots.length,
        snapshots: snapshots.map((s) => ({
          id: s.id,
          timestamp: s.timestamp,
          commitSha: s.commitSha.slice(0, 7),
          branch: s.branch,
          nodes: s.nodeCount,
          edges: s.edgeCount,
          communities: s.communityCount,
          health: s.healthScore,
          cohesion: Math.round(s.cohesion * 1000) / 1000,
          modularity: Math.round(s.modularity * 1000) / 1000,
          complexity: Math.round(s.complexity * 1000) / 1000,
          cycles: s.cycleCount,
          hubs: s.hubCount,
          unstableDeps: s.unstableDepCount,
        })),
        trend_summary: trendSummary,
      };

      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  },
};

return TOOLS;
}
