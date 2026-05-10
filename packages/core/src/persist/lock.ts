/**
 * Database lock file — prevents concurrent CLI analyze and MCP server
 * from writing to the same SQLite database simultaneously.
 *
 * Mitigates architecture Pitfall 3 (WAL corruption from concurrent
 * access — GitNexus issues #1402, #1361).
 */
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { execSync } from 'node:child_process';

const LOCK_FILE_NAME = 'astrolabe.lock';

export interface DbLock {
  release(): void;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 is a no-op that checks if the process exists.
    // On Unix this correctly returns ESRCH for nonexistent PIDs.
    // On Windows, process.kill(pid, 0) always returns true for any
    // running PID regardless of process identity (#696), so we
    // additionally verify via tasklist.
    process.kill(pid, 0);

    if (platform() === 'win32') {
      // tasklist /FI "PID eq NNN" returns the header line plus one
      // data line if the PID exists — filter out to check.
      const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 3000
      }).trim();
      return output.length > 0 && !output.startsWith('INFO:');
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a file lock for the database directory.
 *
 * Writes the current PID to `astrolabe.lock` in the given directory.
 * If a lock file exists and the owning process is still alive,
 * throws an error. If the owning process is dead (stale lock),
 * overwrites it.
 *
 * Returns a {@link DbLock} with a `release()` method.
 */
export function acquireDbLock(dbDir: string): DbLock {
  const lockPath = join(dbDir, LOCK_FILE_NAME);

  if (existsSync(lockPath)) {
    const existing = readFileSync(lockPath, 'utf-8').trim();
    const existingPid = parseInt(existing, 10);
    if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
      throw new Error(
        `Database is locked by another process (PID ${existingPid}). ` +
        `Concurrent analysis or MCP server detected — stop the other process ` +
        `and try again, or remove ${lockPath} if the process has crashed.`
      );
    }
    // Stale lock — overwrite
  }

  writeFileSync(lockPath, String(process.pid), 'utf-8');

  return {
    release() {
      try {
        if (existsSync(lockPath)) unlinkSync(lockPath);
      } catch {
        // Best-effort cleanup — lock file is advisory only
      }
    }
  };
}
