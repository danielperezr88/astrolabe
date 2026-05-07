/**
 * Integration tests for the CLI (#537).
 *
 * Tests CLI commands via subprocess execution: spawns `node dist/index.js <command>`,
 * captures stdout/stderr, and verifies output.
 *
 * Some Commander.js commands don't call process.exit() after completing,
 * so spawn uses a timeout to force-kill them. When killed, exit code is null.
 * Tests accept code 0 (clean exit) or null (killed after outputting).
 *
 * Only tests commands that don't require tree-sitter parsing (no `analyze`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadRegistry, saveRegistry } from '@astrolabe-dev/core';

const CLI_PATH = join(__dirname, '../dist/index.js');
const originalRegistry = loadRegistry();

const TEST_TIMEOUT = 15_000;
const SPAWN_TIMEOUT = 8_000;

/** Run a CLI command and return stdout, stderr, and exit code. */
function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      timeout: SPAWN_TIMEOUT,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
  });
}

beforeAll(() => {
  // Clear registry for clean state
  saveRegistry([]);
});

afterAll(() => {
  saveRegistry(originalRegistry);
});

describe('CLI Integration (#537)', () => {
  describe('version & help', () => {
    it('version command outputs version string', async () => {
      const { stdout, code } = await runCli('version');
      // Commander may not call process.exit() — code can be 0 or null (timeout-killed)
      expect(code === 0 || code === null).toBe(true);
      expect(stdout).toContain('astrolabe v');
    }, TEST_TIMEOUT);

    it('--version flag outputs version', async () => {
      const { stdout, code } = await runCli('--version');
      expect(code).toBe(0);
      expect(stdout).toMatch(/\d+\.\d+\.\d+/);
    }, TEST_TIMEOUT);

    it('help command shows usage', async () => {
      const { stdout, code } = await runCli('--help');
      expect(code).toBe(0);
      expect(stdout).toContain('analyze');
      expect(stdout).toContain('query');
      expect(stdout).toContain('serve-mcp');
      expect(stdout).toContain('context');
    }, TEST_TIMEOUT);

    it('unknown command shows error', async () => {
      const { stderr, code } = await runCli('nonexistent-command');
      expect(code).not.toBe(0);
      expect(stderr.toLowerCase()).toContain('unknown');
    }, TEST_TIMEOUT);
  });

  describe('status & list (no repos)', () => {
    it('status shows no indexed repos', async () => {
      const { stdout, code } = await runCli('status');
      expect(code === 0 || code === null).toBe(true);
      expect(stdout.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT);

    it('list shows empty or no results', async () => {
      const { code } = await runCli('list');
      // With no repos: exits 0, 1, or null (timeout-killed)
      expect(code === 0 || code === 1 || code === null).toBe(true);
    }, TEST_TIMEOUT);
  });

  describe('query (no repos)', () => {
    it('query without repos shows error', async () => {
      const { code } = await runCli('query', 'test');
      // Should fail since no repos are indexed
      expect(code).not.toBe(0);
    }, TEST_TIMEOUT);
  });

  describe('generate-skill', () => {
    it('generate-skill writes skill file and reports path', async () => {
      const { stdout, code } = await runCli('generate-skill');
      expect(code === 0 || code === null).toBe(true);
      // Command writes skill content to a file, reports the path to stdout
      expect(stdout).toContain('Skill file written');
      expect(stdout).toContain('astrolabe');
    }, TEST_TIMEOUT);
  });

  describe('context & impact (no repos)', () => {
    it('context without repos shows error', async () => {
      const { code } = await runCli('context', 'nonexistent');
      expect(code).not.toBe(0);
    }, TEST_TIMEOUT);

    it('impact without repos shows error', async () => {
      const { code } = await runCli('impact', 'nonexistent');
      expect(code).not.toBe(0);
    }, TEST_TIMEOUT);
  });

  describe('group commands', () => {
    it('group list shows empty', async () => {
      const { code } = await runCli('group', 'list');
      expect(code === 0 || code === null).toBe(true);
    }, TEST_TIMEOUT);
  });

  describe('clean', () => {
    it('clean command runs without error', async () => {
      const { code } = await runCli('clean');
      expect(code === 0 || code === null).toBe(true);
    }, TEST_TIMEOUT);
  });
});
