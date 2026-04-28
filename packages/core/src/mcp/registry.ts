/**
 * Shared registry module — single source of truth for repo registration.
 *
 * Used by both CLI (analyze command) and MCP server to avoid duplication (#133).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
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
