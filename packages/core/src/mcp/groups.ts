/**
 * Cross-Repo Groups — multi-repo monorepo tracking (#266).
 *
 * Manages named groups of repositories for cross-repo impact analysis,
 * contract extraction, and federated queries.
 *
 * Groups are persisted to ~/.astrolabe/groups.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { loadRegistry } from './registry.js';
import { createFtsSearch } from '../search/fts.js';
import { autoDetectGroups as detectGroups, type ServiceBoundary } from '../analysis/service-boundary-detector.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface GroupRepo {
  /** Hierarchy path within the group (e.g. "hr/hiring/backend"). */
  path: string;
  /** Registry repo name (must exist in registry.json). */
  repoName: string;
  /** When this repo was added to the group (epoch ms). */
  addedAt: number;
}

export interface RepoGroup {
  /** Group name (unique). */
  name: string;
  /** When the group was created (epoch ms). */
  createdAt: number;
  /** Repositories in this group, keyed by hierarchy path. */
  repos: Record<string, GroupRepo>;
  /** Cross-repo contracts (populated by group sync). */
  contracts?: Record<string, unknown>;
  /** When group_sync last ran (epoch ms). Null if never synced. */
  lastSyncAt?: number;
}

export interface GroupsConfig {
  version: 1;
  groups: Record<string, RepoGroup>;
}

export interface GroupStatus {
  name: string;
  repoCount: number;
  repos: Array<{
    path: string;
    repoName: string;
    stale: boolean;
    lastCommit?: string;
    indexedAt?: string;
    nodeCount?: number;
    edgeCount?: number;
    status: string;
  }>;
  /** True when any member repo was re-analyzed after the last group sync. */
  contractsStale: boolean;
  /** ISO timestamp of the last group_sync, or null if never synced. */
  lastSyncAt: string | null;
  /** Suggestion to re-sync when contracts are stale. */
  recommendation: string | null;
}

// ── Path resolution ────────────────────────────────────────────────────────

function groupsPath(): string {
  const dir = join(homedir(), '.astrolabe');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'groups.json');
}

// ── Config I/O ─────────────────────────────────────────────────────────────

export function loadGroups(): GroupsConfig {
  const path = groupsPath();
  if (!existsSync(path)) return { version: 1, groups: {} };
  try {
    const raw = readFileSync(path, 'utf-8');
    const obj = JSON.parse(raw);
    if (obj?.version === 1 && typeof obj.groups === 'object') {
      return obj as GroupsConfig;
    }
    return { version: 1, groups: {} };
  } catch {
    return { version: 1, groups: {} };
  }
}

export function saveGroups(config: GroupsConfig): void {
  const path = groupsPath();
  const tmp = path + '.tmp-' + randomUUID();
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tmp, path);
}

// ── Group operations ───────────────────────────────────────────────────────

export function createGroup(name: string): RepoGroup {
  const config = loadGroups();
  if (config.groups[name]) {
    throw new Error(`Group "${name}" already exists.`);
  }
  const group: RepoGroup = { name, createdAt: Date.now(), repos: {} };
  config.groups[name] = group;
  saveGroups(config);
  return group;
}

export function removeGroup(name: string): void {
  const config = loadGroups();
  if (!config.groups[name]) {
    throw new Error(`Group "${name}" does not exist.`);
  }
  delete config.groups[name];
  saveGroups(config);
}

export function addRepoToGroup(groupName: string, path: string, repoName: string): GroupRepo {
  const config = loadGroups();
  const group = config.groups[groupName];
  if (!group) throw new Error(`Group "${groupName}" does not exist.`);

  // Validate repo exists in registry
  const registry = loadRegistry();
  if (!registry.find((r) => r.name === repoName)) {
    throw new Error(`Repository "${repoName}" not found in registry. Available: ${registry.map((r) => r.name).join(', ')}`);
  }

  const repo: GroupRepo = { path, repoName, addedAt: Date.now() };
  group.repos[path] = repo;
  saveGroups(config);
  return repo;
}

export function removeRepoFromGroup(groupName: string, path: string): void {
  const config = loadGroups();
  const group = config.groups[groupName];
  if (!group) throw new Error(`Group "${groupName}" does not exist.`);
  if (!group.repos[path]) throw new Error(`Path "${path}" not found in group "${groupName}".`);
  delete group.repos[path];
  saveGroups(config);
}

export function listGroups(): RepoGroup[] {
  const config = loadGroups();
  return Object.values(config.groups);
}

export function getGroup(name: string): RepoGroup | null {
  const config = loadGroups();
  return config.groups[name] ?? null;
}

/**
 * Check the status of all repos in a group — staleness, node counts, etc.
 *
 * This is a lightweight status check (reads meta.json, does not load full graph).
 */
export function getGroupStatus(name: string): GroupStatus {
  const group = getGroup(name);
  if (!group) throw new Error(`Group "${name}" does not exist.`);

  const registry = loadRegistry();
  const repos: GroupStatus['repos'] = [];
  let contractsStale = false;
  const lastSyncAt = group.lastSyncAt != null
    ? new Date(group.lastSyncAt).toISOString()
    : null;

  for (const [path, gr] of Object.entries(group.repos)) {
    const entry = registry.find((r) => r.name === gr.repoName);
    if (!entry) {
      repos.push({ path, repoName: gr.repoName, stale: true, status: 'missing' });
      contractsStale = true; // missing repo means contracts can't be verified
      continue;
    }

    // Check staleness via meta.json
    let stale = false;
    let indexedAt: string | undefined;
    try {
      const metaPath = join(dirname(entry.dbPath), 'meta.json');
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        if (entry.lastCommit && meta.lastCommit !== entry.lastCommit) {
          stale = true;
        }
        if (meta.indexedAt != null) {
          indexedAt = new Date(meta.indexedAt).toISOString();
        }
      }
    } catch { stale = true; }

    // If no indexedAt from meta.json, fall back to registry entry
    if (indexedAt == null && entry.indexedAt != null) {
      indexedAt = new Date(entry.indexedAt).toISOString();
    }

    // Contract staleness: repo was re-analyzed after last sync
    if (group.lastSyncAt != null && entry.indexedAt != null) {
      if (entry.indexedAt > group.lastSyncAt) {
        contractsStale = true;
      }
    } else if (group.lastSyncAt == null && group.contracts != null) {
      // Has contracts but was never synced — stale
      contractsStale = true;
    }

    repos.push({
      path,
      repoName: gr.repoName,
      stale,
      lastCommit: entry.lastCommit,
      indexedAt,
      status: stale ? 'stale' : 'current',
    });
  }

  const recommendation = contractsStale
    ? 'Run group_sync to update contracts'
    : null;

  return { name, repoCount: repos.length, repos, contractsStale, lastSyncAt, recommendation };
}

/**
 * Query across all repos in a group, fanning out to per-repo databases.
 */
export function groupQuery(
  groupName: string,
  query: string,
  limit = 20,
): Array<{ repoName: string; results: Array<{ label: string; name: string; filePath: string; rank: number }> }> {
  const group = getGroup(groupName);
  if (!group) throw new Error(`Group "${groupName}" does not exist.`);

  const registry = loadRegistry();
  const output: Array<{ repoName: string; results: Array<{ label: string; name: string; filePath: string; rank: number }> }> = [];

  for (const [, gr] of Object.entries(group.repos)) {
    const entry = registry.find((r) => r.name === gr.repoName);
    if (!entry || !existsSync(entry.dbPath)) continue;

    try {
      const fts = createFtsSearch(entry.dbPath);
      try {
        const results = fts.search(query, limit);
        output.push({
          repoName: gr.repoName,
          results: results.map((r) => ({
            label: r.label,
            name: r.name,
            filePath: r.filePath,
            rank: (r as any).rank ?? 0,
          })),
        });
      } finally {
        fts.close(); // #412: always close FTS, even if search() throws
      }
    } catch (err) {
      // #324: Log error but continue with other repos in the group
      console.warn(`[groups] Failed to query ${gr.repoName}: ${(err as Error).message}`);
    }
  }

  return output;
}

// ── Service boundary auto-detection ────────────────────────────────────────

/**
 * Auto-detect service boundaries in a repository.
 * Re-exported from service-boundary-detector for convenient access via groups API.
 */
export { detectGroups as autoDetectGroups, type ServiceBoundary };
