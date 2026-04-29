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
import { execSync } from 'node:child_process';

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
      // Check for Cursor installation + mcp config directory
      return existsSync(join(HOME, '.cursor')) ||
             existsSync(join(HOME, 'AppData', 'Roaming', 'Cursor'));
    },
    configure(force) {
      const dir = join(HOME, '.cursor');
      const configPath = join(dir, 'mcp.json');

      if (!force && existsSync(configPath)) {
        // Check if astrolabe is already configured
        try {
          const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (existing.mcpServers?.astrolabe) {
            return { error: 'Already configured (use --force to overwrite)' };
          }
        } catch { /* corrupt config — overwrite */ }
      }

      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let mcp: any = { mcpServers: {} };
      if (existsSync(configPath)) {
        try { mcp = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* start fresh */ }
      }

      mcp.mcpServers = mcp.mcpServers || {};
      mcp.mcpServers.astrolabe = {
        command: 'npx',
        args: ['-y', '@astrolabe/cli', 'serve-mcp'],
      };

      atomicWriteJson(configPath, mcp);
      return { path: configPath };
    },
  },

  {
    name: 'Windsurf',
    detect() {
      return existsSync(join(HOME, '.windsurf')) ||
             existsSync(join(HOME, 'AppData', 'Roaming', 'Windsurf'));
    },
    configure(force) {
      const dir = join(HOME, '.windsurf');
      const configPath = join(dir, 'mcp.json');

      if (!force && existsSync(configPath)) {
        try {
          const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (existing.mcpServers?.astrolabe) {
            return { error: 'Already configured (use --force to overwrite)' };
          }
        } catch { /* corrupt config */ }
      }

      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let mcp: any = { mcpServers: {} };
      if (existsSync(configPath)) {
        try { mcp = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* start fresh */ }
      }

      mcp.mcpServers = mcp.mcpServers || {};
      mcp.mcpServers.astrolabe = {
        command: 'npx',
        args: ['-y', '@astrolabe/cli', 'serve-mcp'],
      };

      atomicWriteJson(configPath, mcp);
      return { path: configPath };
    },
  },

  {
    name: 'OpenCode',
    detect() {
      const paths = [
        join(HOME, '.config', 'opencode'),
        join(HOME, 'AppData', 'Roaming', 'opencode'),
      ];
      return paths.some((p) => existsSync(p));
    },
    configure(force) {
      const dir = join(HOME, '.config', 'opencode');
      const configPath = join(dir, 'config.json');

      if (!force && existsSync(configPath)) {
        try {
          const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (existing.mcpServers?.astrolabe) {
            return { error: 'Already configured (use --force to overwrite)' };
          }
        } catch { /* corrupt config */ }
      }

      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let config: any = { mcpServers: {} };
      if (existsSync(configPath)) {
        try { config = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* start fresh */ }
      }

      config.mcpServers = config.mcpServers || {};
      config.mcpServers.astrolabe = {
        command: 'npx',
        args: ['-y', '@astrolabe/cli', 'serve-mcp'],
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
        return false;
      }
    },
    configure(_force) {
      // Claude Code uses `claude mcp add` command
      try {
        execSync(
          'claude mcp add astrolabe -- npx -y @astrolabe/cli serve-mcp',
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
        } catch { /* corrupt config */ }
      }

      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let mcp: any = {};
      if (existsSync(configPath)) {
        try { mcp = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* start fresh */ }
      }

      mcp.servers = mcp.servers || {};
      mcp.servers.astrolabe = {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@astrolabe/cli', 'serve-mcp'],
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
args = ["-y", "@astrolabe/cli", "serve-mcp"]
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
