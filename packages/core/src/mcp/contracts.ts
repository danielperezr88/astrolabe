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
  contractType: 'http' | 'grpc' | 'topic';
  confidence: number; // 0-1, based on path similarity
}

/** #398: Shared library detected across 2+ repos in a group. */
export interface SharedLibrary {
  /** Package/import name (e.g., "@myorg/common", "shared-utils"). */
  packageName: string;
  /** Repos that import this package. */
  consumerRepos: string[];
  /** Files that import this package, by repo. */
  files: Array<{ repoName: string; filePath: string }>;
}

export interface GroupContracts {
  extractedAt: number;
  providers: Array<ProviderContract & { repoName: string }>;
  consumers: Array<ConsumerContract & { repoName: string }>;
  crossLinks: ContractCrossLink[];
  /** #398: Shared libraries detected across repos. */
  sharedLibs: SharedLibrary[];
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
  { clientType: 'fetch', namePattern: /\bfetch\s*\(/i, urlExtractor: (body) => extractUrlArg(body, 'fetch') },
  { clientType: 'axios', namePattern: /\baxios\.(get|post|put|delete|patch|request)\s*\(/i, urlExtractor: (body) => extractUrlArg(body, 'axios') },
  { clientType: 'got', namePattern: /\bgot\.(get|post|put|delete|patch)\s*\(/i, urlExtractor: (body) => extractUrlArg(body, 'got') },
  { clientType: 'request', namePattern: /\b(request|superagent)\s*\(/i, urlExtractor: (body) => extractUrlArg(body, 'request') },
  { clientType: 'httpClient', namePattern: /\b(httpClient|HttpClient|http\.request)\s*\(/i, urlExtractor: (body) => extractUrlArg(body, 'httpClient') },
];

function extractUrlArg(body: string, _clientType: string): string | null {
  // Extract string URL argument from HTTP client calls.
  // Matches: '/path', '/api/endpoint', 'https://host/path', or simple '/root'
  const match = body.match(/['"`]((?:https?:\/\/[^'"`]+)|(?:\/[^'"`\s]*))['"`]/);
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
          contractType: 'http',
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

// ── #396: gRPC Contract Extraction ─────────────────────────────────────────

export interface GrpcServiceContract {
  serviceName: string;
  rpcMethods: Array<{ name: string; requestType: string; responseType: string }>;
  filePath: string;
  package: string;
}

const GRPC_CLIENT_PATTERNS: Array<{
  clientType: string;
  namePattern: RegExp;
  extractor: (body: string, name: string) => { serviceName: string; methodName: string } | null;
}> = [
  {
    clientType: 'grpc-client',
    namePattern: /\b(client\.|stub\.|new\s+\w+Client)/i,
    extractor: (body: string, name: string) => {
      // Match: client.GetUser(request) or stub.CreateOrder(call, callback)
      const m = body.match(/[.\s]([A-Z]\w+)\.([A-Z]\w+)\s*\(/);
      if (m) return { serviceName: m[1], methodName: m[2] };
      // Match: new UserServiceClient(address)
      const m2 = name.match(/(\w+)(?:Client|Grpc|Stub)/i);
      if (m2) return { serviceName: m2[1], methodName: 'call' };
      return null;
    },
  },
  {
    clientType: 'grpc-generated',
    namePattern: /(?:Stub|Client|Service|Grpc)$/i,
    extractor: (_body: string, name: string) => {
      const base = name.replace(/(?:Stub|Client|Service|Grpc)$/i, '');
      if (base) return { serviceName: base, methodName: 'call' };
      return null;
    },
  },
];

function extractGrpcServices(graph: KnowledgeGraph): GrpcServiceContract[] {
  const services: GrpcServiceContract[] = [];

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Class' && node.label !== 'Interface') continue;
    const name = (node.properties.name as string) ?? '';
    const body = (node.properties.body as string) ?? (node.properties.source as string) ?? '';
    const filePath = (node.properties.filePath as string) ?? '';

    // Detect gRPC service classes: class UserService { GetUser() {...} CreateUser() {...} }
    if (/(?:Service|Grpc|Stub)\s*$/.test(name) && filePath.endsWith('.proto')) continue;
    if (!/(?:Service|Grpc|Stub)\s*$/.test(name)) continue;

    const methodCalls: Array<{ name: string; requestType: string; responseType: string }> = [];
    // Look for methods that take (call, callback) gRPC handler pattern
    const methodMatches = body.matchAll(/(\w+)\s*\(\s*call\s*,\s*callback\s*\)/g);
    for (const m of methodMatches) {
      methodCalls.push({ name: m[1], requestType: 'Request', responseType: 'Response' });
    }

    // Also detect methods named after RPC calls (starts with uppercase)
    if (methodCalls.length === 0) {
      const rpcMethods = body.matchAll(/([A-Z]\w+)\s*\([^)]*\)\s*(?::|{)/g);
      for (const m of rpcMethods) {
        if (m[1] !== 'constructor' && !m[1].startsWith('get') && !m[1].startsWith('set')) {
          methodCalls.push({ name: m[1], requestType: 'Request', responseType: 'Response' });
        }
      }
    }

    if (methodCalls.length > 0) {
      services.push({
        serviceName: name,
        rpcMethods: methodCalls.slice(0, 20),
        filePath,
        package: 'default',
      });
    }
  }

  return services;
}

function extractGrpcClients(graph: KnowledgeGraph): ConsumerContract[] {
  const clients: ConsumerContract[] = [];

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Function' && node.label !== 'Method') continue;
    const name = (node.properties.name as string) ?? '';
    const body = (node.properties.body as string) ?? (node.properties.source as string) ?? '';
    const filePath = (node.properties.filePath as string) ?? '';

    for (const pattern of GRPC_CLIENT_PATTERNS) {
      if (pattern.namePattern.test(name) || pattern.namePattern.test(body)) {
        const result = pattern.extractor(body, name);
        if (result) {
          clients.push({
            urlPattern: `${result.serviceName}.${result.methodName}`,
            functionName: name,
            filePath,
            clientType: pattern.clientType,
          });
          break;
        }
      }
    }
  }

  return clients;
}

// ── #397: Topic/Queue Contract Extraction ───────────────────────────────────

export interface TopicContract {
  topicName: string;
  direction: 'producer' | 'consumer';
  broker: string; // 'kafka' | 'rabbitmq' | 'nats' | 'sqs' | 'pubsub'
  functionName: string;
  filePath: string;
}

const TOPIC_PRODUCER_PATTERNS: Array<{
  broker: string;
  pattern: RegExp;
}> = [
  { broker: 'kafka', pattern: /(?:producer|kafka)\.send\s*\(\s*\{[^}]*topic\s*:\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'kafka', pattern: /\.send\s*\(\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'rabbitmq', pattern: /channel\.(?:publish|sendToQueue)\s*\(\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'rabbitmq', pattern: /\.(?:publish|sendToQueue)\s*\(\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'nats', pattern: /(?:nc|nats|stan)\.publish\s*\(\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'nats', pattern: /\.publish\s*\(\s*['"`]([^'"`]+)['"`]\s*,/i },
  { broker: 'sqs', pattern: /sqs\.sendMessage\s*\(\s*\{[^}]*QueueUrl[^}]*\}\s*\)/i },
  { broker: 'pubsub', pattern: /topic\.publish\s*\(\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'pubsub', pattern: /\.publishMessage\s*\(\s*\{[^}]*topic\s*:\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'generic', pattern: /\.(?:publish|send|emit|produce)\s*\(\s*['"`]([^'"`]+)['"`]\s*,/i },
];

const TOPIC_CONSUMER_PATTERNS: Array<{
  broker: string;
  pattern: RegExp;
}> = [
  { broker: 'kafka', pattern: /(?:consumer|kafka)\.subscribe\s*\(\s*\{[^}]*topic\s*:\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'kafka', pattern: /\.subscribe\s*\(\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'rabbitmq', pattern: /channel\.(?:consume|subscribe)\s*\(\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'rabbitmq', pattern: /\.(?:consume|subscribe)\s*\(\s*['"`]([^'"`]+)['"`]\s*,/i },
  { broker: 'nats', pattern: /(?:nc|nats|stan)\.subscribe\s*\(\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'nats', pattern: /\.subscribe\s*\(\s*['"`]([^'"`]+)['"`]\s*,/i },
  { broker: 'sqs', pattern: /sqs\.receiveMessage\s*\(\s*\{[^}]*QueueUrl[^}]*\}\s*\)/i },
  { broker: 'pubsub', pattern: /(?:subscription|topic)\.on\s*\(\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'pubsub', pattern: /\.onMessage\s*\(\s*['"`]([^'"`]+)['"`]/i },
  { broker: 'generic', pattern: /\.(?:consume|subscribe|on|listen|receive)\s*\(\s*['"`]([^'"`]+)['"`]\s*,/i },
];

function extractTopicContracts(graph: KnowledgeGraph): TopicContract[] {
  const contracts: TopicContract[] = [];

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Function' && node.label !== 'Method') continue;
    const name = (node.properties.name as string) ?? '';
    const body = (node.properties.body as string) ?? (node.properties.source as string) ?? '';
    const filePath = (node.properties.filePath as string) ?? '';
    const searchText = name + ' ' + body;

    for (const { broker, pattern } of TOPIC_PRODUCER_PATTERNS) {
      const m = searchText.match(pattern);
      if (m) {
        contracts.push({ topicName: m[1], direction: 'producer', broker, functionName: name, filePath });
        break;
      }
    }

    for (const { broker, pattern } of TOPIC_CONSUMER_PATTERNS) {
      const m = searchText.match(pattern);
      if (m) {
        contracts.push({ topicName: m[1], direction: 'consumer', broker, functionName: name, filePath });
        break;
      }
    }
  }

  return contracts;
}

// ── #398: Shared Library Detection ──────────────────────────────────────────

/** List of well-known stdlib / runtime modules to exclude from shared lib detection. */
const STDLIB_MODULES = new Set([
  'fs', 'path', 'os', 'http', 'https', 'url', 'crypto', 'stream', 'buffer',
  'child_process', 'events', 'util', 'assert', 'net', 'tls', 'dns', 'dgram',
  'cluster', 'readline', 'repl', 'vm', 'zlib', 'querystring', 'string_decoder',
  'timers', 'tty', 'v8', 'worker_threads', 'perf_hooks', 'async_hooks',
  'domain', 'module', 'punycode', 'trace_events', 'wasi', 'inspector',
]);

function isInternalPackage(importPath: string): boolean {
  // Skip stdlib / runtime modules
  if (STDLIB_MODULES.has(importPath)) return false;
  // Skip node_modules (scoped or not)
  if (importPath.startsWith('node:')) return false;
  // Keep workspace packages (scoped like @myorg/..., or bare internal like shared-utils)
  // These typically come from the same monorepo/workspace
  return true;
}

function extractSharedLibs(
  group: import('./groups.js').RepoGroup,
  registry: import('./registry.js').RegistryEntry[],
): SharedLibrary[] {
  const allImports = new Map<string, Array<{ repoName: string; filePath: string }>>();

  for (const [, gr] of Object.entries(group.repos)) {
    const entry = registry.find((r) => r.name === gr.repoName);
    if (!entry || !existsSync(entry.dbPath)) continue;

    let store: ReturnType<typeof createSqliteStore> | null = null;
    try {
      store = createSqliteStore(entry.dbPath);
      const graph = store.loadGraph();

      for (const rel of graph.iterRelationships()) {
        if (rel.type !== 'IMPORTS') continue;
        const target = graph.getNode(rel.targetId);
        if (!target) continue;
        const importPath = (target.properties.name as string) ?? target.id;
        if (!isInternalPackage(importPath)) continue;

        const source = graph.getNode(rel.sourceId);
        const filePath = (source?.properties.filePath as string) ?? '';

        if (!allImports.has(importPath)) {
          allImports.set(importPath, []);
        }
        allImports.get(importPath)!.push({ repoName: gr.repoName, filePath });
      }
    } catch {
      // skip repos that can't be loaded
    } finally {
      store?.close();
    }
  }

  // Filter to packages imported by 2+ repos
  const sharedLibs: SharedLibrary[] = [];
  for (const [packageName, files] of allImports) {
    const consumerRepos = [...new Set(files.map((f) => f.repoName))];
    if (consumerRepos.length >= 2) {
      sharedLibs.push({
        packageName,
        consumerRepos,
        files: files.slice(0, 50), // cap file list per shared lib
      });
    }
  }

  // Sort by number of consumer repos (most shared first)
  sharedLibs.sort((a, b) => b.consumerRepos.length - a.consumerRepos.length);

  return sharedLibs;
}

// ── #396: gRPC Cross-Linking ────────────────────────────────────────────────

function matchGrpcContracts(
  providers: Array<GrpcServiceContract & { repoName: string }>,
  consumers: Array<ConsumerContract & { repoName: string }>,
): ContractCrossLink[] {
  const links: ContractCrossLink[] = [];

  for (const consumer of consumers) {
    // consumer.urlPattern is "ServiceName.MethodName"
    const parts = consumer.urlPattern.split('.');
    if (parts.length < 2) continue;
    const svcName = parts[0];

    for (const provider of providers) {
      if (consumer.repoName === provider.repoName) continue;

      // Match service name
      const svcBase = provider.serviceName.replace(/(?:Service|Grpc|Stub)$/i, '');
      if (svcBase.toLowerCase() === svcName.toLowerCase() ||
          provider.serviceName.toLowerCase() === svcName.toLowerCase()) {
        links.push({
          provider: { repoName: provider.repoName, path: provider.serviceName, method: 'grpc' },
          consumer: { repoName: consumer.repoName, functionName: consumer.functionName, filePath: consumer.filePath },
          contractType: 'grpc',
          confidence: 0.7,
        });
      }
    }
  }

  return links;
}

// ── #397: Topic Cross-Linking ───────────────────────────────────────────────

function matchTopicContracts(
  allTopics: Array<TopicContract & { repoName: string }>,
): ContractCrossLink[] {
  const links: ContractCrossLink[] = [];
  const producers = allTopics.filter((t) => t.direction === 'producer');
  const consumers = allTopics.filter((t) => t.direction === 'consumer');

  for (const producer of producers) {
    for (const consumer of consumers) {
      if (producer.repoName === consumer.repoName) continue;

      if (producer.topicName.toLowerCase() === consumer.topicName.toLowerCase()) {
        links.push({
          provider: { repoName: producer.repoName, path: producer.topicName, method: producer.broker },
          consumer: { repoName: consumer.repoName, functionName: consumer.functionName, filePath: consumer.filePath },
          contractType: 'topic',
          confidence: 0.8,
        });
      }
    }
  }

  return links;
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

  // #396: gRPC contracts
  const allGrpcProviders: Array<GrpcServiceContract & { repoName: string }> = [];
  const allGrpcConsumers: Array<ConsumerContract & { repoName: string }> = [];
  // #397: topic contracts
  const allTopics: Array<TopicContract & { repoName: string }> = [];

  for (const [, gr] of Object.entries(group.repos)) {
    const entry = registry.find((r) => r.name === gr.repoName);
    if (!entry || !existsSync(entry.dbPath)) {
      results.push({ repoName: gr.repoName, providerCount: 0, consumerCount: 0, crossLinks: 0, error: 'DB not found' });
      continue;
    }

    let store: ReturnType<typeof createSqliteStore> | null = null;
    try {
      store = createSqliteStore(entry.dbPath);
      const graph = store.loadGraph();

      const providers = extractProviders(graph).map((p) => ({ ...p, repoName: gr.repoName }));
      const consumers = extractConsumers(graph).map((c) => ({ ...c, repoName: gr.repoName }));

      allProviders.push(...providers);
      allConsumers.push(...consumers);

      // #396: gRPC extraction
      const grpcServices = extractGrpcServices(graph);
      for (const svc of grpcServices) {
        allGrpcProviders.push({ ...svc, repoName: gr.repoName });
        // Each RPC method becomes a consumer-like target
        for (const m of svc.rpcMethods) {
          allGrpcConsumers.push({
            urlPattern: `${svc.serviceName}.${m.name}`,
            functionName: m.name,
            filePath: svc.filePath,
            clientType: 'grpc',
            repoName: gr.repoName,
          });
        }
      }
      const grpcClients = extractGrpcClients(graph).map((c) => ({ ...c, repoName: gr.repoName }));
      allGrpcConsumers.push(...grpcClients);

      // #397: topic extraction
      const topics = extractTopicContracts(graph).map((t) => ({ ...t, repoName: gr.repoName }));
      allTopics.push(...topics);

      results.push({ repoName: gr.repoName, providerCount: providers.length, consumerCount: consumers.length, crossLinks: 0 });
    } catch (err) {
      results.push({ repoName: gr.repoName, providerCount: 0, consumerCount: 0, crossLinks: 0, error: (err as Error).message });
    } finally {
      store?.close(); // #386: always close to prevent connection leak
    }
  }

  // HTTP cross-linking
  const httpLinks = matchContracts(allProviders, allConsumers);

  // #396: gRPC cross-linking — match gRPC consumers to service providers
  const grpcLinks = matchGrpcContracts(allGrpcProviders, allGrpcConsumers);

  // #397: topic cross-linking — match producers to consumers by topic name
  const topicLinks = matchTopicContracts(allTopics);

  // Merge all cross-links
  const crossLinks: ContractCrossLink[] = [...httpLinks, ...grpcLinks, ...topicLinks];

  // Update cross-link counts per repo
  for (const result of results) {
    if (result.error) continue;
    result.crossLinks = crossLinks.filter(
      (l) => l.provider.repoName === result.repoName || l.consumer.repoName === result.repoName,
    ).length;
  }

  // #398: Extract shared libraries across repos
  const sharedLibs = extractSharedLibs(group, registry);

  // Persist contracts to group config
  const contracts: GroupContracts = {
    extractedAt: Date.now(),
    providers: allProviders,
    consumers: allConsumers,
    crossLinks,
    sharedLibs,
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
