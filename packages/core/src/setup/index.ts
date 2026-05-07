/**
 * Auto-Setup — detects installed editors and writes MCP configuration (#263).
 *
 * Scans well-known config paths for: Cursor, Claude Code, Windsurf, OpenCode,
 * VS Code, Codex. Writes the correct MCP server configuration for each detected
 * editor so users can start using Astrolabe immediately after `astrolabe setup`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { appDataDir } from '@astrolabe-dev/shared';
import { createLogger } from '../logging/index.js';

const log = createLogger({ level: 'debug' });

// ── Atomic write helper (#333) ─────────────────────────────────────────────

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp-' + Date.now();
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

function atomicWriteText(filePath: string, text: string): void {
  const tmp = filePath + '.tmp-' + Date.now();
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, filePath);
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface SetupResult {
  editor: string;
  configured: boolean;
  path?: string;
  error?: string;
  skipped?: string; // reason for skipping
}

// ── Editor detectors ──────────────────────────────────────────────────────

interface EditorConfig {
  name: string;
  /** Check if the editor is installed. */
  detect(): boolean;
  /** Write MCP config. Returns path written. */
  configure(force: boolean): { path: string } | { error: string };
}

const HOME = homedir();

const EDITORS: EditorConfig[] = [
  {
    name: 'Cursor',
    detect() {
      // Cross-platform: check all possible Cursor config directories
      const candidates = [
        join(HOME, '.cursor'),                         // Linux / universal fallback
        join(appDataDir(), 'Cursor'),                  // macOS: ~/Library/Application Support/Cursor, Windows: %APPDATA%/Cursor
      ];
      return candidates.some((p) => existsSync(p));
    },
    configure(force) {
      // Use platform-appropriate config directory
      const dir = existsSync(join(HOME, '.cursor'))
        ? join(HOME, '.cursor')
        : join(appDataDir(), 'Cursor');
      const configPath = join(dir, 'mcp.json');

      if (!force && existsSync(configPath)) {
        // Check if astrolabe is already configured
        try {
          const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (existing.mcpServers?.astrolabe) {
            return { error: 'Already configured (use --force to overwrite)' };
          }
        } catch (err) { log.debug('Corrupt MCP config, will overwrite', { path: configPath, error: String(err) }); }
      }

      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let mcp: any = { mcpServers: {} };
      if (existsSync(configPath)) {
        try { mcp = JSON.parse(readFileSync(configPath, 'utf-8')); } catch (err) { log.debug('Starting fresh MCP config', { path: configPath, error: String(err) }); }
      }

      mcp.mcpServers = mcp.mcpServers || {};
      mcp.mcpServers.astrolabe = {
        command: 'npx',
        args: ['-y', '@astrolabe-dev/cli', 'serve-mcp'],
      };

      atomicWriteJson(configPath, mcp);
      return { path: configPath };
    },
  },

  {
    name: 'Windsurf',
    detect() {
      // Cross-platform: check all possible Windsurf config directories
      const candidates = [
        join(HOME, '.windsurf'),                       // Linux / universal fallback
        join(appDataDir(), 'Windsurf'),                // macOS: ~/Library/Application Support/Windsurf, Windows: %APPDATA%/Windsurf
      ];
      return candidates.some((p) => existsSync(p));
    },
    configure(force) {
      // Use platform-appropriate config directory
      const dir = existsSync(join(HOME, '.windsurf'))
        ? join(HOME, '.windsurf')
        : join(appDataDir(), 'Windsurf');
      const configPath = join(dir, 'mcp.json');

      if (!force && existsSync(configPath)) {
        try {
          const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (existing.mcpServers?.astrolabe) {
            return { error: 'Already configured (use --force to overwrite)' };
          }
        } catch (err) { log.debug('Corrupt Windsurf MCP config, will overwrite', { path: configPath, error: String(err) }); }
      }

      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let mcp: any = { mcpServers: {} };
      if (existsSync(configPath)) {
        try { mcp = JSON.parse(readFileSync(configPath, 'utf-8')); } catch (err) { log.debug('Starting fresh Windsurf MCP config', { path: configPath, error: String(err) }); }
      }

      mcp.mcpServers = mcp.mcpServers || {};
      mcp.mcpServers.astrolabe = {
        command: 'npx',
        args: ['-y', '@astrolabe-dev/cli', 'serve-mcp'],
      };

      atomicWriteJson(configPath, mcp);
      return { path: configPath };
    },
  },

  {
    name: 'OpenCode',
    detect() {
      // Cross-platform: check all possible OpenCode config directories
      const candidates = [
        join(HOME, '.config', 'opencode'),             // Linux (XDG)
        join(appDataDir(), 'opencode'),                // macOS: ~/Library/Application Support/opencode, Windows: %APPDATA%/opencode
      ];
      return candidates.some((p) => existsSync(p));
    },
    configure(force) {
      // Use first existing platform-appropriate config directory
      const candidates = [
        join(HOME, '.config', 'opencode'),
        join(appDataDir(), 'opencode'),
      ];
      const dir = candidates.find((p) => existsSync(p)) || candidates[0];
      const configPath = join(dir, 'config.json');

      if (!force && existsSync(configPath)) {
        try {
          const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (existing.mcpServers?.astrolabe) {
            return { error: 'Already configured (use --force to overwrite)' };
          }
        } catch (err) { log.debug('Corrupt OpenCode config, will overwrite', { path: configPath, error: String(err) }); }
      }

      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let config: any = { mcpServers: {} };
      if (existsSync(configPath)) {
        try { config = JSON.parse(readFileSync(configPath, 'utf-8')); } catch (err) { log.debug('Starting fresh OpenCode config', { path: configPath, error: String(err) }); }
      }

      config.mcpServers = config.mcpServers || {};
      config.mcpServers.astrolabe = {
        command: 'npx',
        args: ['-y', '@astrolabe-dev/cli', 'serve-mcp'],
      };

      atomicWriteJson(configPath, config);
      return { path: configPath };
    },
  },

  {
    name: 'Claude Code',
    detect() {
      // Claude Code is a CLI tool — check if it's installed
      try {
        execSync('claude --version', { stdio: 'ignore', timeout: 3000 });
        return true;
      } catch {
        log.debug('Claude Code CLI not detected');
        return false;
      }
    },
    configure(_force) {
      // Claude Code uses `claude mcp add` command
      // Use execFileSync for cross-platform argument safety (avoids shell parsing issues)
      try {
        execFileSync(
          'claude', ['mcp', 'add', 'astrolabe', '--', 'npx', '-y', '@astrolabe-dev/cli', 'serve-mcp'],
          { stdio: 'pipe', timeout: 10000, encoding: 'utf-8' },
        );
        return { path: 'via claude mcp add' };
      } catch (err: any) {
        const msg = err.stderr || err.message || String(err);
        if (msg.includes('already exists')) {
          return { error: 'Already configured (use --force to remove first)' };
        }
        return { error: `Failed: ${msg.slice(0, 100)}` };
      }
    },
  },

  {
    name: 'VS Code',
    detect() {
      // Check project-level .vscode directory
      return existsSync(join(process.cwd(), '.vscode'));
    },
    configure(force) {
      const dir = join(process.cwd(), '.vscode');
      const configPath = join(dir, 'mcp.json');

      if (!force && existsSync(configPath)) {
        try {
          const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (existing.servers?.astrolabe) {
            return { error: 'Already configured (use --force to overwrite)' };
          }
        } catch (err) { log.debug('Corrupt VS Code MCP config, will overwrite', { path: configPath, error: String(err) }); }
      }

      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let mcp: any = {};
      if (existsSync(configPath)) {
        try { mcp = JSON.parse(readFileSync(configPath, 'utf-8')); } catch (err) { log.debug('Starting fresh VS Code MCP config', { path: configPath, error: String(err) }); }
      }

      mcp.servers = mcp.servers || {};
      mcp.servers.astrolabe = {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@astrolabe-dev/cli', 'serve-mcp'],
      };

      atomicWriteJson(configPath, mcp);
      return { path: configPath };
    },
  },

  {
    name: 'Codex',
    detect() {
      return existsSync(join(HOME, '.codex'));
    },
    configure(force) {
      const configPath = join(HOME, '.codex', 'config.toml');

      if (!force && existsSync(configPath)) {
        const content = readFileSync(configPath, 'utf-8');
        if (content.includes('[mcp_servers.astrolabe]')) {
          return { error: 'Already configured (use --force to overwrite)' };
        }
      }

      const tomlBlock = `
[mcp_servers.astrolabe]
command = "npx"
args = ["-y", "@astrolabe-dev/cli", "serve-mcp"]
`;

      const dir = join(HOME, '.codex');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      if (existsSync(configPath) && !force) {
        atomicWriteText(configPath, readFileSync(configPath, 'utf-8') + tomlBlock);
      } else {
        atomicWriteText(configPath, tomlBlock.trim() + '\n');
      }

      return { path: configPath };
    },
  },
];

// ── Setup function ────────────────────────────────────────────────────────

/**
 * Detect installed editors and write MCP configuration.
 *
 * @param force — Overwrite existing configs even if already configured.
 * @returns Results for each editor (configured or skipped).
 */
export function autoSetup(force = false): SetupResult[] {
  const results: SetupResult[] = [];

  for (const editor of EDITORS) {
    if (!editor.detect()) {
      results.push({ editor: editor.name, configured: false, skipped: 'Not detected' });
      continue;
    }

    const result = editor.configure(force);
    if ('error' in result) {
      results.push({ editor: editor.name, configured: false, error: result.error });
    } else {
      results.push({ editor: editor.name, configured: true, path: result.path });
    }
  }

  return results;
}
