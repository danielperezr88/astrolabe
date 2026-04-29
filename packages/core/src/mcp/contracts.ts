/**
 * Cross-Repo Contract Extraction (#370).
 *
 * Detects HTTP API contracts (providers = route handlers, consumers = HTTP clients)
 * across repositories in a group and matches them for cross-repo impact analysis.
 *
 * Contracts are persisted in the group config (~/.astrolabe/groups.json).
 */

import { existsSync } from 'node:fs';
import { loadRegistry } from './registry.js';
import { createSqliteStore } from '../persist/sqlite.js';
import type { KnowledgeGraph, GraphNode } from '@astrolabe/shared';
import type { RepoGroup } from './groups.js';
import { loadGroups } from './groups.js';
import { saveGroups } from './groups.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProviderContract {
  method: string;
  path: string;
  handlerName: string;
  filePath: string;
  framework: string;
}

export interface ConsumerContract {
  urlPattern: string;
  functionName: string;
  filePath: string;
  clientType: string; // 'fetch' | 'axios' | 'got' | 'request' | 'httpClient'
}

export interface ContractCrossLink {
  provider: { repoName: string; path: string; method: string };
  consumer: { repoName: string; functionName: string; filePath: string };
  confidence: number; // 0-1, based on path similarity
}

export interface GroupContracts {
  extractedAt: number;
  providers: Array<ProviderContract & { repoName: string }>;
  consumers: Array<ConsumerContract & { repoName: string }>;
  crossLinks: ContractCrossLink[];
}

export interface ContractSyncResult {
  repoName: string;
  providerCount: number;
  consumerCount: number;
  crossLinks: number;
  error?: string;
}

// ── Provider extraction (routes) ────────────────────────────────────────────

function extractProviders(graph: KnowledgeGraph): ProviderContract[] {
  const providers: ProviderContract[] = [];
  const handlerNodes = new Map<string, GraphNode>();

  // Collect handler ↔ route relationships
  for (const rel of graph.iterRelationshipsByType('HANDLES_ROUTE')) {
    const routeNode = graph.getNode(rel.targetId);
    const handlerNode = graph.getNode(rel.sourceId);
    if (!routeNode || routeNode.label !== 'Route') continue;
    if (!handlerNode) continue;

    handlerNodes.set(rel.sourceId, handlerNode);

    const idParts = routeNode.id.split(':');
    // id format: route:{filePath}:{framework}:{method}:{path}
    const framework = idParts[2] ?? 'unknown';
    const method = (routeNode.properties.method as string)?.toUpperCase() ?? 'GET';
    const path = (routeNode.properties.path as string) ?? '/';
    const handlerName = (handlerNode.properties.name as string) ?? handlerNode.id;
    const filePath = (routeNode.properties.filePath as string) ?? '';

    providers.push({ method, path, handlerName, filePath, framework });
  }

  return providers;
}

// ── Consumer extraction (HTTP clients) ──────────────────────────────────────

const HTTP_CLIENT_PATTERNS: Array<{
  clientType: string;
  namePattern: RegExp;
  urlExtractor: (body: string) => string | null;
}> = [
  { clientType: 'fetch', namePattern: /fetch/i, urlExtractor: (body) => extractUrlArg(body, 'fetch') },
  { clientType: 'axios', namePattern: /axios/i, urlExtractor: (body) => extractUrlArg(body, 'axios') },
  { clientType: 'got', namePattern: /got/i, urlExtractor: (body) => extractUrlArg(body, 'got') },
  { clientType: 'request', namePattern: /request/i, urlExtractor: (body) => extractUrlArg(body, 'request') },
  { clientType: 'httpClient', namePattern: /httpClient|http\.request|HttpClient/i, urlExtractor: (body) => extractUrlArg(body, 'httpClient') },
];

function extractUrlArg(body: string, _clientType: string): string | null {
  // Extract first string argument after client call: fetch('url'), axios.get('url'), etc.
  const match = body.match(/['"`]([^'"`]+\/[^'"`]*)['"`]/);
  return match ? match[1] : null;
}

function extractConsumers(graph: KnowledgeGraph): ConsumerContract[] {
  const consumers: ConsumerContract[] = [];

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Function' && node.label !== 'Method') continue;
    const name = (node.properties.name as string) ?? '';
    const body = (node.properties.body as string) ?? (node.properties.source as string) ?? '';
    const filePath = (node.properties.filePath as string) ?? '';

    for (const pattern of HTTP_CLIENT_PATTERNS) {
      if (pattern.namePattern.test(name) || pattern.namePattern.test(body)) {
        const urlPattern = pattern.urlExtractor(body);
        if (urlPattern) {
          consumers.push({
            urlPattern,
            functionName: name,
            filePath,
            clientType: pattern.clientType,
          });
          break; // one match per node
        }
      }
    }
  }

  return consumers;
}

// ── Cross-linking ───────────────────────────────────────────────────────────

function matchContracts(
  providers: Array<ProviderContract & { repoName: string }>,
  consumers: Array<ConsumerContract & { repoName: string }>,
): ContractCrossLink[] {
  const links: ContractCrossLink[] = [];

  for (const consumer of consumers) {
    for (const provider of providers) {
      // Skip same-repo matches (intra-repo calls are already captured)
      if (consumer.repoName === provider.repoName) continue;

      const confidence = pathSimilarity(consumer.urlPattern, provider.path);
      if (confidence > 0.3) {
        links.push({
          provider: { repoName: provider.repoName, path: provider.path, method: provider.method },
          consumer: { repoName: consumer.repoName, functionName: consumer.functionName, filePath: consumer.filePath },
          confidence: Math.round(confidence * 100) / 100,
        });
      }
    }
  }

  // Sort by confidence descending
  links.sort((a, b) => b.confidence - a.confidence);
  return links;
}

function pathSimilarity(urlPattern: string, routePath: string): number {
  // Simple path overlap: segment-based Jaccard similarity
  const segs1 = new Set(urlPattern.split('/').filter(Boolean));
  const segs2 = new Set(routePath.split('/').filter(Boolean));

  if (segs1.size === 0 && segs2.size === 0) return 0;
  if (segs1.size === 0 || segs2.size === 0) return 0;

  const intersection = new Set([...segs1].filter((s) => segs2.has(s)));
  const union = new Set([...segs1, ...segs2]);

  return intersection.size / union.size;
}

// ── Sync ────────────────────────────────────────────────────────────────────

export function syncGroupContracts(groupName: string): ContractSyncResult[] {
  const config = loadGroups();
  const group = config.groups[groupName];
  if (!group) throw new Error(`Group "${groupName}" does not exist.`);

  const registry = loadRegistry();
  const allProviders: Array<ProviderContract & { repoName: string }> = [];
  const allConsumers: Array<ConsumerContract & { repoName: string }> = [];
  const results: ContractSyncResult[] = [];

  for (const [, gr] of Object.entries(group.repos)) {
    const entry = registry.find((r) => r.name === gr.repoName);
    if (!entry || !existsSync(entry.dbPath)) {
      results.push({ repoName: gr.repoName, providerCount: 0, consumerCount: 0, crossLinks: 0, error: 'DB not found' });
      continue;
    }

    try {
      const store = createSqliteStore(entry.dbPath);
      const graph = store.loadGraph();

      const providers = extractProviders(graph).map((p) => ({ ...p, repoName: gr.repoName }));
      const consumers = extractConsumers(graph).map((c) => ({ ...c, repoName: gr.repoName }));

      allProviders.push(...providers);
      allConsumers.push(...consumers);
      store.close();

      results.push({ repoName: gr.repoName, providerCount: providers.length, consumerCount: consumers.length, crossLinks: 0 });
    } catch (err) {
      results.push({ repoName: gr.repoName, providerCount: 0, consumerCount: 0, crossLinks: 0, error: (err as Error).message });
    }
  }

  // Cross-link across repos
  const crossLinks = matchContracts(allProviders, allConsumers);

  // Update cross-link counts per repo
  for (const result of results) {
    if (result.error) continue;
    result.crossLinks = crossLinks.filter(
      (l) => l.provider.repoName === result.repoName || l.consumer.repoName === result.repoName,
    ).length;
  }

  // Persist contracts to group config
  const contracts: GroupContracts = {
    extractedAt: Date.now(),
    providers: allProviders,
    consumers: allConsumers,
    crossLinks,
  };

  const updatedGroup: RepoGroup = {
    ...group,
    contracts: contracts as unknown as Record<string, unknown>,
  };
  config.groups[groupName] = updatedGroup;
  saveGroups(config);

  return results;
}

export function getGroupContracts(groupName: string): GroupContracts | null {
  const config = loadGroups();
  const group = config.groups[groupName];
  if (!group) throw new Error(`Group "${groupName}" does not exist.`);

  const contracts = (group as RepoGroup & { contracts?: GroupContracts }).contracts;
  return contracts ?? null;
}
