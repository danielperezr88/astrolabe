/**
 * Shared registry module — single source of truth for repo registration.
 *
 * Used by both CLI (analyze command) and MCP server to avoid duplication (#133).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../logging/logger.js';

const log = createLogger({ level: 'info' });

export interface RegistryEntry {
  name: string;
  path: string;
  dbPath: string;
  lastCommit: string;
  indexedAt: number;
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
  const resolvedTarget = target.replace(/[/\\]+$/, ''); // strip trailing slashes
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
