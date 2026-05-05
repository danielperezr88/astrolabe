/**
 * Cross-platform path utilities.
 *
 * All internal path handling normalizes to POSIX (forward-slash) format
 * for consistent comparison, storage, and graph key generation.
 * Use these helpers instead of raw `.replace(/\\/g, '/')` scattered across files.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Normalize a file path to POSIX (forward-slash) format.
 * Safe for use as graph keys, comparison, and relative-path operations.
 *
 * Example:
 *   toPosix('C:\\Users\\repo\\src') → 'C:/Users/repo/src'
 *   toPosix('/home/user/repo/src')  → '/home/user/repo/src'
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Get the basename (last segment) of a path, cross-platform.
 * Normalizes separators first so both `/` and `\` work.
 *
 * Example:
 *   pathBasename('src\\utils\\helpers.ts') → 'helpers.ts'
 *   pathBasename('src/utils/helpers.ts')   → 'helpers.ts'
 */
export function pathBasename(p: string): string {
  return toPosix(p).split('/').pop() ?? p;
}

/**
 * Strip trailing path separators from a path.
 * Handles both `/` and `\` and combinations thereof.
 *
 * Example:
 *   stripTrailingSep('repo/')   → 'repo'
 *   stripTrailingSep('repo\\')  → 'repo'
 *   stripTrailingSep('repo')    → 'repo'
 */
export function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

/**
 * Check if a path looks like a relative import specifier.
 * Handles both POSIX and Windows-style relative paths.
 *
 * Example:
 *   isRelativeImport('./utils')    → true
 *   isRelativeImport('../parent')  → true
 *   isRelativeImport('lodash')     → false
 */
export function isRelativeImport(value: string): boolean {
  return value.startsWith('.') || value.startsWith('/');
}

/**
 * Get platform-specific application data directory for editor configs.
 *
 * Windows: %APPDATA% (e.g., C:\Users\x\AppData\Roaming)
 * macOS:   ~/Library/Application Support
 * Linux:   ~/.config (or $XDG_CONFIG_HOME)
 */
export function appDataDir(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return process.env.APPDATA;
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support');
  }

  // Linux & fallback
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}
