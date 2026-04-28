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
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch (err) {
    // #232: Log corruption instead of silently returning [] — prevents
    // downstream code from auto-saving an empty array and wiping all entries.
    log.warn('Registry file corrupted, ignoring', { path: REGISTRY_FILE, error: String(err) });
    return []; // caller must not auto-save this empty result
  }
}

export function saveRegistry(entries: RegistryEntry[]): void {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  // #232: Atomic write via temp + rename — prevents corruption from concurrent writes
  const tmp = REGISTRY_FILE + '.tmp-' + Date.now();
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, REGISTRY_FILE);
}
