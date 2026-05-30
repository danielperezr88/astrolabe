/**
 * MCP Resource handlers — static resources, resource templates, and read handlers.
 *
 * Extracted from server.ts for modularity (#838).
 * Uses factory pattern: createResourceHandlers(backend) returns bound functions.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { GraphNode } from '../core/types.js';
import { getGroupStatus } from './groups.js';
import { getGroupContracts } from './contracts.js';
import type { LocalBackend } from './backend.js';

export interface ResourceHandlers {
  getResources: () => Array<{ uri: string; name: string; description: string; mimeType: string }>;
  getResourceTemplates: () => Array<{ uriTemplate: string; name: string; description: string; mimeType: string }>;
  readResource: (uri: string) => string | null;
}

export function createResourceHandlers(backend: LocalBackend): ResourceHandlers {

function getResources() {
  return [
    { uri: 'astrolabe://repos', name: 'All Indexed Repositories', description: 'List all indexed repositories with stats', mimeType: 'text/plain' },
    { uri: 'astrolabe://setup', name: 'Astrolabe Setup Content', description: 'Returns AGENTS.md content for all indexed repos. Useful for setup/onboarding.', mimeType: 'text/markdown' },
    { uri: 'astrolabe://repo/{name}/context', name: 'Repo Context', description: 'Codebase overview, stats, staleness check', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/clusters', name: 'Clusters', description: 'All functional clusters with cohesion scores', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/processes', name: 'Processes', description: 'All execution flows', mimeType: 'text/plain' },
    { uri: 'astrolabe://repo/{name}/schema', name: 'Graph Schema', description: 'Node labels and relationship types', mimeType: 'text/plain' },
  ];
}

function getResourceTemplates() {
  return [
    { uriTemplate: 'astrolabe://repo/{name}/cluster/{clusterId}', name: 'Cluster Details', description: 'Cluster members, cohesion score, entry points, and key symbols', mimeType: 'text/plain' },
    { uriTemplate: 'astrolabe://repo/{name}/process/{processId}', name: 'Process Trace', description: 'Step-by-step execution trace with symbols and edges', mimeType: 'text/plain' },
    { uriTemplate: 'astrolabe://group/{name}/contracts', name: 'Group Contracts', description: 'Cross-repo contract registry with providers, consumers, and cross-links', mimeType: 'text/yaml' },
    { uriTemplate: 'astrolabe://group/{name}/status', name: 'Group Status', description: 'Per-repo index staleness and contract-registry status', mimeType: 'text/yaml' },
  ];
}
function readResource(uri: string): string | null {
  // astrolabe://repos
  if (uri === 'astrolabe://repos') {
    const repos = backend.listRepos();
    return repos.length === 0 ? 'No indexed repositories.' : repos.map((r) => `- ${r.name} (${r.path}) — indexed ${new Date(r.indexedAt).toISOString()}`).join('\n');
  }

  // astrolabe://repo/{name}/context
  const ctxMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/context$/);
  if (ctxMatch) {
    try {
      const ctx = backend.getRepo(ctxMatch[1]);
      const graph = ctx.loadGraph();
      return `Repository: ${ctx.entry.name}\nPath: ${ctx.entry.path}\nNodes: ${graph.nodeCount}\nRelationships: ${graph.relationshipCount}\nLast indexed: ${new Date(ctx.entry.indexedAt).toISOString()}\nLast commit: ${ctx.entry.lastCommit}`;
    } catch { return null; }
  }

  // astrolabe://repo/{name}/clusters
  const clMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/clusters$/);
  if (clMatch) {
    try {
      const ctx = backend.getRepo(clMatch[1]);
      const graph = ctx.loadGraph();
      const clusters: string[] = [];
      for (const node of graph.iterNodes()) {
        if (node.label === 'Community') clusters.push(`- ${node.properties.name ?? node.id} (${node.properties.symbolCount ?? 0} symbols, cohesion: ${node.properties.cohesion ?? 0})`);
      }
      return clusters.length === 0 ? 'No clusters detected.' : clusters.join('\n');
    } catch { return null; }
  }

  // astrolabe://repo/{name}/cluster/{clusterId}
  const ccMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/cluster\/(.+)$/);
  if (ccMatch) {
    try {
      const ctx = backend.getRepo(ccMatch[1]);
      const graph = ctx.loadGraph();
      const clusterId = ccMatch[2];
      const members: string[] = [];
      const memberIds = new Set<string>();
      let cohesion = 0;
      let clusterLabel = clusterId;
      for (const node of graph.iterNodes()) {
        if (node.label !== 'Community') continue;
        if (node.id === clusterId || node.properties.name === clusterId || node.id.includes(clusterId)) {
          if (!node.properties.name) continue;
          clusterLabel = (node.properties.name as string) ?? clusterId;
          cohesion = (node.properties.cohesion as number) ?? 0;
          for (const rel of graph.iterRelationships()) {
            if (rel.type === 'MEMBER_OF' && rel.targetId === node.id) {
              const sym = graph.getNode(rel.sourceId);
              if (sym) {
                members.push(`- ${sym.label.padEnd(12)} ${sym.properties.name ?? '?'} (${sym.properties.filePath ?? '?'})`);
                memberIds.add(sym.id);
              }
            }
          }
          break;
        }
      }
      if (members.length === 0) return `Cluster "${clusterId}" not found.`;

      // Entry points: cluster members that are process entry points
      const entryPoints: string[] = [];
      for (const rel of graph.iterRelationshipsByType('ENTRY_POINT_OF')) {
        if (memberIds.has(rel.sourceId)) {
          const sym = graph.getNode(rel.sourceId);
          if (sym) entryPoints.push(`- ${sym.properties.name ?? sym.id} (${sym.label} — ${sym.properties.filePath ?? '?'})`);
        }
      }

      // Key symbols: members with most intra-cluster connections
      const connCount = new Map<string, number>();
      for (const rel of graph.iterRelationships()) {
        if (rel.type === 'STEP_IN_PROCESS' || rel.type === 'MEMBER_OF' || rel.type === 'ENTRY_POINT_OF') continue;
        if (memberIds.has(rel.sourceId) && memberIds.has(rel.targetId)) {
          connCount.set(rel.sourceId, (connCount.get(rel.sourceId) ?? 0) + 1);
          connCount.set(rel.targetId, (connCount.get(rel.targetId) ?? 0) + 1);
        }
      }
      const keySymbols = Array.from(connCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, count]) => {
          const sym = graph.getNode(id);
          return `- ${sym?.properties.name ?? id} (${count} connections)`;
        });

      const parts = [`Cluster: ${clusterLabel}`, `Cohesion: ${cohesion}`, '', 'Members:', ...members];
      if (entryPoints.length > 0) parts.push('', 'Entry Points:', ...entryPoints);
      if (keySymbols.length > 0) parts.push('', 'Key Symbols:', ...keySymbols);
      return parts.join('\n');
    } catch { return null; }
  }

  // astrolabe://repo/{name}/processes
  const prMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/processes$/);
  if (prMatch) {
    try {
      const ctx = backend.getRepo(prMatch[1]);
      const graph = ctx.loadGraph();
      const processes: string[] = [];
      for (const node of graph.iterNodes()) {
        if (node.label === 'Process') processes.push(`- ${node.properties.name ?? node.id} (${node.properties.stepCount ?? 0} steps, type: ${node.properties.processType ?? 'intra'})`);
      }
      return processes.length === 0 ? 'No processes detected.' : processes.join('\n');
    } catch { return null; }
  }

  // astrolabe://repo/{name}/process/{processId}
  const ptMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/process\/(.+)$/);
  if (ptMatch) {
    try {
      const ctx = backend.getRepo(ptMatch[1]);
      const graph = ctx.loadGraph();
      const processId = ptMatch[2];
      let processNode: GraphNode | undefined;
      const steps: Array<{ step: number; name: string; label: string; filePath: string; id: string }> = [];

      for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
        const proc = graph.getNode(rel.sourceId);
        if (proc && (proc.id === processId || proc.properties.name === processId)) {
          if (!processNode) processNode = proc;
          const sym = graph.getNode(rel.targetId);
          if (sym) {
            steps.push({
              step: rel.step ?? 0,
              name: (sym.properties.name as string) ?? sym.id,
              label: sym.label,
              filePath: (sym.properties.filePath as string) ?? '?',
              id: sym.id,
            });
          }
        }
      }

      if (steps.length === 0) return 'Process not found.';
      steps.sort((a, b) => a.step - b.step);

      // Find edges between step symbols
      const stepIds = new Set(steps.map(s => s.id));
      const edges: string[] = [];
      for (const rel of graph.iterRelationships()) {
        if (rel.type === 'STEP_IN_PROCESS' || rel.type === 'MEMBER_OF') continue;
        if (stepIds.has(rel.sourceId) && stepIds.has(rel.targetId)) {
          const srcName = graph.getNode(rel.sourceId)?.properties.name ?? rel.sourceId;
          const tgtName = graph.getNode(rel.targetId)?.properties.name ?? rel.targetId;
          edges.push(`- ${srcName} → ${rel.type} → ${tgtName}`);
        }
      }

      const processType = (processNode?.properties.processType as string) ?? 'intra_community';
      const stepCount = (processNode?.properties.stepCount as number) ?? steps.length;
      const parts = [
        `Process: ${processNode?.properties.name ?? processId}`,
        `Type: ${processType}`,
        `Steps: ${stepCount}`,
        '',
        'Trace:',
        ...steps.map(s => `Step ${s.step}: ${s.name} (${s.label} — ${s.filePath})`),
      ];
      if (edges.length > 0) parts.push('', 'Edges:', ...edges);
      return parts.join('\n');
    } catch { return null; }
  }

  // astrolabe://repo/{name}/schema
  const scMatch = uri.match(/^astrolabe:\/\/repo\/([^/]+)\/schema$/);
  if (scMatch) {
    const name = scMatch[1];
    try {
      const ctx = backend.getRepo(name);
      const graph = ctx.loadGraph();
      const labels = new Set<string>();
      const types = new Set<string>();
      for (const node of graph.iterNodes()) labels.add(node.label);
      for (const rel of graph.iterRelationships()) types.add(rel.type);
      return `Node Labels: ${Array.from(labels).sort().join(', ')}\nRelationship Types: ${Array.from(types).sort().join(', ')}`;
    } catch {
      return `Node Labels: File, Folder, Package, Function, Class, Method, Interface, Enum, Variable, Import, Community, Process, Route, Tool, Section, Framework\nRelationship Types: ACCESSES, CONTAINS, CALLS, EXTENDS, IMPLEMENTS, IMPORTS, USES, DEFINES, HAS_METHOD, HAS_PROPERTY, MEMBER_OF, STEP_IN_PROCESS, HANDLES_ROUTE, ENTRY_POINT_OF, USES_FRAMEWORK`;
    }
  }

  // #404: astrolabe://setup — AGENTS.md content for all indexed repos
  if (uri === 'astrolabe://setup') {
    return generateSetupResource();
  }

  // #399: astrolabe://group/{name}/contracts — contract registry
  const gcMatch = uri.match(/^astrolabe:\/\/group\/([^/]+)\/(contracts|status)$/);
  if (gcMatch) {
    const groupName = gcMatch[1];
    const resourceType = gcMatch[2];
    if (resourceType === 'status') {
      return generateGroupStatusResource(groupName);
    }
    return generateGroupContractsResource(groupName, uri);
  }

  return null;
}

/**
 * #404: Read AGENTS.md files from all indexed repos and combine them.
 * Useful for setup/onboarding when an AI agent first connects.
 */
function generateSetupResource(): string {
  const repos = backend.listRepos();

  if (repos.length === 0) {
    return '# Astrolabe\n\nNo repositories indexed. Run: `astrolabe analyze <path>` in a repository.';
  }

  const sections: string[] = [];

  for (const repo of repos) {
    const agentsPath = pathJoin(repo.path, 'AGENTS.md');
    if (existsSync(agentsPath)) {
      const content = readFileSync(agentsPath, 'utf-8');
      sections.push(`# ${repo.name}\n\n${content}`);
    }
  }

  if (sections.length === 0) {
    return '# Astrolabe\n\nNo AGENTS.md files found in indexed repositories.';
  }

  return sections.join('\n\n---\n\n');
}

/**
 * #399: Generate group status resource content.
 */
function generateGroupStatusResource(groupName: string): string {
  try {
    const status = getGroupStatus(groupName);
    const lines: string[] = [`group: "${status.name}"`, `repos: ${status.repoCount}`, '', 'members:'];
    for (const repo of status.repos) {
      const icon = repo.stale ? '⚠ STALE' : '✓ current';
      const indexed = repo.indexedAt ? new Date(repo.indexedAt).toISOString() : 'never';
      lines.push(`  - path: "${repo.path}"`);
      lines.push(`    repo: "${repo.repoName}"`);
      lines.push(`    status: "${icon}"`);
      lines.push(`    indexed: "${indexed}"`);
      if (repo.lastCommit) lines.push(`    commit: "${repo.lastCommit.substring(0, 7)}"`);
      if (repo.nodeCount !== undefined) lines.push(`    symbols: ${repo.nodeCount}`);
      if (repo.edgeCount !== undefined) lines.push(`    edges: ${repo.edgeCount}`);
    }
    return lines.join('\n');
  } catch (e: any) {
    return `error: ${e.message}`;
  }
}

/**
 * #399: Generate group contracts resource content.
 * Supports optional query params: ?type=, ?repo=, ?unmatchedOnly=true|false
 */
function generateGroupContractsResource(groupName: string, uri: string): string {
  try {
    const contracts = getGroupContracts(groupName);
    if (!contracts) {
      return `group: "${groupName}"\ncontracts: []\n# No contracts extracted. Run group_sync first.`;
    }

    // Parse query params from URI
    let filterType: string | undefined;
    let filterRepo: string | undefined;
    let unmatchedOnly: boolean | undefined;
    try {
      const u = new URL(uri);
      filterType = u.searchParams.get('type')?.trim() || undefined;
      filterRepo = u.searchParams.get('repo')?.trim() || undefined;
      const uo = u.searchParams.get('unmatchedOnly');
      if (uo === 'true' || uo === '1') unmatchedOnly = true;
      else if (uo === 'false' || uo === '0') unmatchedOnly = false;
    } catch { /* no query params */ }

    // Apply filters
    let crossLinks = contracts.crossLinks;
    if (filterType === 'http' || !filterType) { /* HTTP is default, all current links are HTTP */ }
    if (filterRepo) {
      crossLinks = crossLinks.filter((cl) =>
        cl.provider.repoName === filterRepo || cl.consumer.repoName === filterRepo);
    }
    if (unmatchedOnly) {
      crossLinks = crossLinks.filter((cl) => cl.confidence < 0.5);
    }

    const lines: string[] = [
      `group: "${groupName}"`,
      `extracted: "${new Date(contracts.extractedAt).toISOString()}"`,
      `providers: ${contracts.providers.length}`,
      `consumers: ${contracts.consumers.length}`,
      `crossLinks: ${crossLinks.length}`,
      '',
    ];

    if (crossLinks.length > 0) {
      lines.push('contracts:');
      for (const cl of crossLinks.slice(0, 50)) {
        lines.push(`  - provider: "${cl.provider.repoName} ${cl.provider.method} ${cl.provider.path}"`);
        lines.push(`    consumer: "${cl.consumer.repoName} ${cl.consumer.functionName}"`);
        lines.push(`    confidence: ${cl.confidence.toFixed(2)}`);
      }
      if (crossLinks.length > 50) lines.push(`  # ... and ${crossLinks.length - 50} more`);
    }

    return lines.join('\n');
  } catch (e: any) {
    return `error: ${e.message}`;
  }
}


return { getResources, getResourceTemplates, readResource };
}