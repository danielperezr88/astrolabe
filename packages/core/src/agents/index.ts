/**
 * AGENTS.md / CLAUDE.md context auto-generation (#268).
 *
 * Generates and maintains agent context files with knowledge graph stats,
 * MCP tool reference, and usage rules. Content is placed between
 * <!-- astrolabe:start --> and <!-- astrolabe:end --> markers so users
 * can add custom content outside the block.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KnowledgeGraph } from '../core/types.js';
import type { RegistryEntry } from '../mcp/registry.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface GenerateOptions {
  repoName: string;
  repoPath: string;
  nodeCount: number;
  relationshipCount: number;
  processCount: number;
  communityCount: number;
  routeCount: number;
  toolCount: number;
  lastCommit: string;
  isIncremental: boolean;
  /** #267: Graph reference for community skill generation. */
  graph?: KnowledgeGraph;
  /** #267: Registry entry for dbPath reference. */
  entry?: RegistryEntry;
  /** #267: Generate per-community SKILL.md files. */
  skills?: boolean;
  /** #267: Core agent skill files directory path. */
  coreSkillsPath?: string;
}

// ── Block markers ─────────────────────────────────────────────────────────

const START_MARKER = '<!-- astrolabe:start -->';
const END_MARKER = '<!-- astrolabe:end -->';

// ── Content generation ────────────────────────────────────────────────────

function generateBlock(opts: GenerateOptions): string {
  const routes = opts.routeCount > 0 ? `, ${opts.routeCount} routes` : '';
  const tools = opts.toolCount > 0 ? `, ${opts.toolCount} tools` : '';
  const mode = opts.isIncremental ? ' (incremental)' : '';

  return `${START_MARKER}
# Astrolabe — Code Intelligence${mode}

This project is indexed by **Astrolabe** as \`${opts.repoName}\`.

${opts.nodeCount} symbols, ${opts.relationshipCount} relationships, ${opts.processCount} execution flows${routes}${tools}

## MCP Tools

| Tool | Purpose |
|------|---------|
| \`astrolabe.query\` | Hybrid search over the knowledge graph |
| \`astrolabe.context\` | 360-degree symbol view (incoming/outgoing edges, processes) |
| \`astrolabe.impact\` | Blast radius analysis — upstream/downstream impact |
| \`astrolabe.detect_changes\` | Git-diff based impact mapping |
| \`astrolabe.route_map\` | Map API routes to handlers and consumers |
| \`astrolabe.api_impact\` | Pre-change impact report for route handlers |
| \`astrolabe.tool_map\` | Map tool definitions to handlers and callers |
| \`astrolabe.filter_by_label\` | Filter graph nodes by label |

## Resources

| URI | Content |
|-----|---------|
| \`astrolabe://repo/${opts.repoName}/context\` | Codebase overview, stats, staleness check |
| \`astrolabe://repo/${opts.repoName}/clusters\` | Functional clusters with cohesion scores |
| \`astrolabe://repo/${opts.repoName}/processes\` | Execution flows |
| \`astrolabe://repo/${opts.repoName}/schema\` | Graph schema (node labels + relationship types) |

## Always Do

1. Run \`detect_changes()\` **before** committing to verify your changes match expected impact
2. Run \`impact({target: "<symbol>"})\` before editing to understand blast radius
3. Read \`astrolabe://repo/${opts.repoName}/clusters\` to understand functional boundaries
4. Use \`context({name: "<symbol>"})\` for 360° symbol understanding

## Never Do

1. Never edit a HIGH-risk symbol without checking impact first
2. Never ignore stale index warnings — run \`astrolabe analyze${opts.repoPath ? ` ${opts.repoPath}` : ''}\` if HEAD has advanced
3. Never skip \`detect_changes()\` before committing in a high-change file

## CLI

\`\`\`bash
astrolabe analyze ${opts.repoPath}    # Re-index the codebase
astrolabe query "<search>"            # Search symbols
astrolabe context <symbol>            # Symbol context
astrolabe impact <symbol>             # Impact analysis
astrolabe status                      # Check analysis status
\`\`\`

Last indexed: ${opts.lastCommit ? opts.lastCommit.substring(0, 7) : 'unknown'}
${END_MARKER}`;
}

// ── Atomic file write (#337) ─────────────────────────────────────────────

function atomicWrite(path: string, content: string): void {
  const tmp = path + '.tmp-' + randomUUID();
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

// ── File update logic ─────────────────────────────────────────────────────

function updateFile(path: string, newBlock: string): boolean {
  if (existsSync(path)) {
    const content = readFileSync(path, 'utf-8');
    const startIdx = content.indexOf(START_MARKER);
    const endIdx = content.indexOf(END_MARKER);

    if (startIdx !== -1 && endIdx !== -1) {
      // Replace existing block
      const before = content.substring(0, startIdx);
      const after = content.substring(endIdx + END_MARKER.length);
      atomicWrite(path, before + newBlock + after);
      return true;
    }

    // Append to existing file
    atomicWrite(path, content.trimEnd() + '\n\n' + newBlock + '\n');
    return true;
  }

  // Create new file
  writeFileSync(path, newBlock + '\n', 'utf-8');
  return true;
}

// ── Public API ────────────────────────────────────────────────────────────

export interface AgentFilesResult {
  agentsMd: boolean;
  claudeMd: boolean;
  /** #267: Number of community skill files generated. */
  skillsCount: number;
}

/**
 * Generate or update AGENTS.md and CLAUDE.md files in the repo root.
 *
 * Content is placed between <!-- astrolabe:start --> and <!-- astrolabe:end -->
 * markers. Existing content outside these markers is preserved.
 */
export function generateAgentFiles(repoPath: string, opts: GenerateOptions): AgentFilesResult {
  let agentsMd = false;
  let claudeMd = false;
  let skillsCount = 0;

  const block = generateBlock(opts);

  // AGENTS.md
  const agentsPath = join(repoPath, 'AGENTS.md');
  agentsMd = updateFile(agentsPath, block);

  // CLAUDE.md
  const claudePath = join(repoPath, 'CLAUDE.md');
  claudeMd = updateFile(claudePath, block);

  // #267: Generate per-community SKILL.md files
  if (opts.skills && opts.graph) {
    skillsCount = generateCommunitySkills(repoPath, opts);
    // #358: Install core skills AFTER community skills (rmSync clears dir first)
    installCoreSkills(repoPath);
  }

  return { agentsMd, claudeMd, skillsCount };
}

// ── Core Agent Skills (#267) ────────────────────────────────────────────────

function installCoreSkills(repoPath: string): void {
  const skillsDir = join(repoPath, '.astrolabe', 'skills');

  if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });

  // #359: Inline core skill content — works in both dev and published packages
  const coreSkills: Array<{ name: string; content: string }> = [
    { name: 'exploring', content: '# Exploring — Navigate Unfamiliar Code\n\nUse Astrolabe to understand codebase structure before editing.\n\n## Quick Start\n- `astrolabe://repo/{name}/context` — Repo overview\n- `astrolabe.query {"query": "<keyword>"}` — Search symbols\n- `astrolabe.context {"name": "<symbol>"}` — 360° view\n\n## Pro Tips\n- Start with `context` before any edit\n- Use `filter_by_label` to find entry points\n- Read `cluster` to understand module boundaries' },
    { name: 'debugging', content: '# Debugging — Trace Bugs Through Call Chains\n\nUse Astrolabe to follow bug symptoms to root causes.\n\n## Quick Start\n- `astrolabe.query {"query": "<function>"}` — Find the symbol\n- `astrolabe.context {"name": "<function>"}` — Get call chain\n- `astrolabe.impact {"target": "<function>", "direction": "upstream"}` — Find callers\n\n## Pro Tips\n- Check for HIGH/WILL BREAK in impact results\n- Use `detect_changes` after fixing to verify' },
    { name: 'impact-analysis', content: '# Impact Analysis — Blast Radius Before Changes\n\nUse Astrolabe to calculate impact before committing.\n\n## Quick Start\n- `astrolabe.impact {"scope": "unstaged"}` — Pre-commit check\n- `astrolabe.api_impact {"name": "<handler>"}` — Route impact\n- `astrolabe.tool_map` — Tool usage map\n\n## Risk Levels\n- LOW: No consumers → safe\n- MEDIUM: Internal callers → add tests\n- HIGH: Exported callers → check carefully\n- WILL BREAK: Do NOT proceed without migration plan' },
    { name: 'refactoring', content: '# Refactoring — Plan Safe Refactors\n\nUse Astrolabe to plan and execute safe refactors.\n\n## Quick Start\n1. `astrolabe.impact {"target": "<symbol>", "depth": 2}` — See all consumers\n2. Rename/move in code\n3. `astrolabe detect_changes` — Verify only expected changes\n4. `astrolabe analyze .` — Re-index if needed\n\n## Patterns\n- **Rename**: impact → rename → detect_changes\n- **Extract**: clusters → move files → analyze\n- **Migrate**: tool_map + route_map → incremental migration' },
  ];

  for (const { name, content } of coreSkills) {
    writeFileSync(join(skillsDir, `${name}.md`), content, 'utf-8');
  }
}

// ── Community Skills (#267) ─────────────────────────────────────────────────

function generateCommunitySkills(repoPath: string, opts: GenerateOptions): number {
  const skillsDir = join(repoPath, '.astrolabe', 'skills');

  // #339: Clean stale skills from previous runs
  if (existsSync(skillsDir)) {
    rmSync(skillsDir, { recursive: true, force: true });
  }
  mkdirSync(skillsDir, { recursive: true });

  const graph = opts.graph!;
  const communities = new Map<string, string[]>();

  // #336: Pre-build MEMBER_OF index for O(1) lookup (was O(S×R))
  const memberOf = new Map<string, string>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'MEMBER_OF') {
      const target = graph.getNode(rel.targetId);
      if (target) memberOf.set(rel.sourceId, (target.properties.name as string) ?? target.id);
    }
  }

  // Collect communities and their symbols
  for (const node of graph.iterNodes()) {
    if (node.label === 'Community') {
      const name = (node.properties.name as string) ?? node.id;
      if (!communities.has(name)) communities.set(name, []);
    } else if (['Function', 'Class', 'Method', 'Interface'].includes(node.label)) {
      const symbolName = (node.properties.name as string) ?? node.id;
      const cName = memberOf.get(node.id);
      if (cName) {
        if (!communities.has(cName)) communities.set(cName, []);
        communities.get(cName)!.push(symbolName);
      }
    }
  }

  // Generate a SKILL.md per community
  let count = 0;
  for (const [name, symbols] of communities) {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const content = [
      `# ${name} — Module Skill\n`,
      `**Generated by Astrolabe** | **Repo**: \`${opts.repoName}\`\n`,
      `\n## Key Symbols (${symbols.length})\n`,
      symbols.map((s) => `- \`${s}\``).join('\n') || '- _(none)_',
      `\n## Entry Points\n`,
      `_detected entry points for this community_`,
      `\n## How to Navigate\n`,
      `Use these MCP tools:`,
      `- \`astrolabe.query {"query": "<symbol>"}\` — search symbols`,
      `- \`astrolabe.context {"name": "<symbol>"}\` — full 360° view`,
      `- \`astrolabe.impact {"scope": "unstaged"}\` — pre-change impact`,
    ].join('\n');

    const skillPath = join(skillsDir, `${safeName}.md`);
    writeFileSync(skillPath, content, 'utf-8');
    count++;
  }

  return count;
}
