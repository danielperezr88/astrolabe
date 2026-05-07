/**
 * Shared registry module — single source of truth for repo registration.
 *
 * Used by both CLI (analyze command) and MCP server to avoid duplication (#133).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createLogger } from '../logging/logger.js';

const log = createLogger({ level: 'info' });

export interface RegistryEntry {
  name: string;
  path: string;
  dbPath: string;
  lastCommit: string;
  indexedAt: number;
  /** Git remote URL for sibling clone detection */
  remoteUrl?: string;
}

const REGISTRY_DIR = join(homedir(), '.astrolabe');
const REGISTRY_FILE = join(REGISTRY_DIR, 'registry.json');

export function loadRegistry(): RegistryEntry[] {
  try {
    if (!existsSync(REGISTRY_FILE)) return [];
    const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
    // #302: Validate JSON structure before returning — malformed data causes cryptic errors
    if (!Array.isArray(data)) {
      log.warn('Registry file is not an array, ignoring', { path: REGISTRY_FILE });
      return [];
    }
    return data.filter((e: unknown) =>
      typeof e === 'object' && e !== null && 'name' in e && 'path' in e && 'dbPath' in e,
    ) as RegistryEntry[];
  } catch (err) {
    log.warn('Registry file corrupted, ignoring', { path: REGISTRY_FILE, error: String(err) });
    return [];
  }
}

/**
 * Get the git remote URL for a repository.
 * Returns null if not a git repo or git command fails.
 */
export function getGitRemote(repoPath: string): string | null {
  try {
    return execSync('git remote get-url origin', { cwd: repoPath, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Result type for sibling clone detection.
 */
export interface SiblingCloneInfo {
  isSibling: boolean;
  indexedPath: string;
  indexedRemoteUrl: string;
  currentPath: string;
}

/**
 * Detect if the given repo path is a sibling clone of another indexed repo.
 * A sibling clone has the same remote URL but a different local path.
 *
 * Returns SiblingCloneInfo if a sibling is found, null otherwise.
 */
export function detectSiblingClone(repoPath: string): SiblingCloneInfo | null {
  const currentRemote = getGitRemote(repoPath);
  if (!currentRemote) return null;

  const entries = loadRegistry();
  for (const entry of entries) {
    if (entry.path === repoPath) continue; // skip self
    if (entry.remoteUrl && entry.remoteUrl === currentRemote) {
      return {
        isSibling: true,
        indexedPath: entry.path,
        indexedRemoteUrl: entry.remoteUrl,
        currentPath: repoPath,
      };
    }
  }
  return null;
}

/**
 * Find a registry entry by path, with sibling clone warning.
 * Returns { entry, siblingWarning } where siblingWarning is a warning message
 * if the current path is a sibling clone of an indexed repo.
 */
export function findEntryWithSiblingWarning(repoPath: string): { entry: RegistryEntry | undefined; siblingWarning: string | null } {
  const entries = loadRegistry();

  // First try exact path match
  let entry = entries.find((e) => e.path === repoPath);

  // If not found by exact path, check for siblings with same remote
  if (!entry) {
    const sibling = detectSiblingClone(repoPath);
    if (sibling) {
      const warning = `Warning: This repo (${sibling.currentPath}) shares the same remote URL as another indexed clone (${sibling.indexedPath}). Data may be stale or duplicated. Consider re-analyzing from the primary location.`;
      log.warn('Sibling clone detected', { current: sibling.currentPath, indexed: sibling.indexedPath, remoteUrl: sibling.indexedRemoteUrl });
      // Return the sibling's entry as a fallback
      entry = entries.find((e) => e.path === sibling.indexedPath);
      return { entry, siblingWarning: warning };
    }
  }

  return { entry: undefined, siblingWarning: null };
}

export function saveRegistry(entries: RegistryEntry[]): void {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  // #232: Atomic write via temp + rename — prevents corruption from concurrent writes
  const tmp = REGISTRY_FILE + '.tmp-' + Date.now();
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, REGISTRY_FILE);
}

/**
 * Remove a repo from the registry by name, alias, or path.
 * Returns the removed entry, or null if no match was found.
 */
export function removeRepo(target: string): RegistryEntry | null {
  const entries = loadRegistry();
  const resolvedTarget = target.replace(/[/\\]*$/, ''); // strip trailing slashes
  let matchIndex = entries.findIndex(
    (e) => e.name === resolvedTarget || e.path === resolvedTarget,
  );

  // Try resolving as an absolute path if no direct match
  if (matchIndex < 0) {
    const absTarget = resolve(resolvedTarget);
    matchIndex = entries.findIndex((e) => e.path === absTarget);
  }

  if (matchIndex < 0) return null;
  const [removed] = entries.splice(matchIndex, 1);
  saveRegistry(entries);
  return removed;
}
