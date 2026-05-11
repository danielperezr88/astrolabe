/**
 * AGENTS.md / CLAUDE.md context auto-generation (#268).
 *
 * Generates and maintains agent context files with knowledge graph stats,
 * MCP tool reference, and usage rules. Content is placed between
 * <!-- astrolabe:start --> and <!-- astrolabe:end --> markers so users
 * can add custom content outside the block.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
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
  /** #760: Omit volatile counts (node/edge stats) from generated content. */
  noStats?: boolean;
}

// ── Block markers ─────────────────────────────────────────────────────────

const START_MARKER = '<!-- astrolabe:start -->';
const END_MARKER = '<!-- astrolabe:end -->';

// ── Content generation ────────────────────────────────────────────────────

function generateBlock(opts: GenerateOptions): string {
  const routes = opts.routeCount > 0 ? `, ${opts.routeCount} routes` : '';
  const tools = opts.toolCount > 0 ? `, ${opts.toolCount} tools` : '';
  const communities = opts.communityCount > 0 ? `, ${opts.communityCount} communities` : '';
  const mode = opts.isIncremental ? ' (incremental)' : '';

  const statsLine = opts.noStats
    ? ''
    : `\n${opts.nodeCount} symbols, ${opts.relationshipCount} relationships, ${opts.processCount} execution flows${routes}${tools}${communities}\n`;

  return `${START_MARKER}
# Astrolabe — Code Intelligence${mode}

This project is indexed by **Astrolabe** as \`${opts.repoName}\`.
${statsLine}
## MCP Tools

**Core Analysis**

| Tool | Purpose |
|------|---------|
| \`astrolabe.query\` | Hybrid search over the knowledge graph |
| \`astrolabe.context\` | 360-degree symbol view (incoming/outgoing edges, processes) |
| \`astrolabe.impact\` | Blast radius analysis — upstream/downstream impact |
| \`astrolabe.detect_changes\` | Git-diff based impact mapping |
| \`astrolabe.filter_by_label\` | Filter graph nodes by label |
| \`astrolabe.grep\` | Regex search across indexed files |

**Architecture & Refactoring**

| Tool | Purpose |
|------|---------|
| \`astrolabe.route_map\` | Map API routes to handlers and consumers |
| \`astrolabe.api_impact\` | Pre-change impact report for route handlers |
| \`astrolabe.tool_map\` | Map tool definitions to handlers and callers |
| \`astrolabe.shape_check\` | Detect API response shape mismatches |
| \`astrolabe.rename\` | Preview multi-file symbol rename (dry_run mode) |
| \`astrolabe.cypher\` | Graph traversal query engine |
| \`astrolabe.graph_algorithms\` | PageRank, betweenness centrality, shortest path |

**Cross-Repo Groups**

| Tool | Purpose |
|------|---------|
| \`astrolabe.group_list\` | List all cross-repo groups |
| \`astrolabe.group_status\` | Check group staleness |
| \`astrolabe.group_query\` | Fan-out search across group repos |
| \`astrolabe.group_sync\` | Extract cross-repo HTTP contracts |
| \`astrolabe.group_contracts\` | Inspect extracted contracts |
| \`astrolabe.group_impact\` | Cross-repo impact via contract tracing |

**AI**

| Tool | Purpose |
|------|---------|
| \`astrolabe.chat\` | RAG conversational AI assistant |

## Resources

| URI | Content |
|-----|---------|
| \`astrolabe://repos\` | All indexed repositories |
| \`astrolabe://setup\` | AGENTS.md content for onboarding |
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
astrolabe index ${opts.repoPath}      # Register existing analysis
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
  atomicWrite(path, newBlock + '\n');
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
    // #358: Install skills to editor directories (Claude Code, Cursor)
    installSkillFilesToEditors(repoPath);
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
    atomicWrite(join(skillsDir, `${name}.md`), content);
  }
}

// ── Editor Skill Installation (#358) ─────────────────────────────────────────

/**
 * Copy skill files from .astrolabe/skills to editor-specific directories.
 * Installs to .claude/skills/generated/ (Claude Code) and .cursor/skills/generated/ (Cursor).
 */
function installSkillFilesToEditors(repoPath: string): void {
  const skillsDir = join(repoPath, '.astrolabe', 'skills');
  if (!existsSync(skillsDir)) return;

  const editors = [
    { root: '.claude', sub: 'skills/generated' },
    { root: '.cursor', sub: 'skills/generated' },
  ];

  const files = readdirSync(skillsDir).filter((f) => f.endsWith('.md'));

  for (const { root, sub } of editors) {
    const targetDir = join(repoPath, root, sub);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    for (const file of files) {
      copyFileSync(join(skillsDir, file), join(targetDir, file));
    }
  }
}

// ── Community Skills (#267, #631) ────────────────────────────────────────────

/** Rich per-community data for skill file generation (#631). */
interface CommunityData {
  name: string;
  id: string;
  cohesion: number;
  symbolCount: number;
  members: Array<{ id: string; label: string; name: string; filePath: string }>;
  entryPoints: Array<{ name: string; label: string; filePath: string }>;
  keySymbols: Array<{ name: string; connections: number }>;
  keyFiles: Array<{ path: string; symbolCount: number }>;
  processes: Array<{ name: string; type: string; steps: number }>;
  crossCommunityLinks: Array<{ direction: 'inbound' | 'outbound'; target: string; symbol: string; edgeType: string }>;
}

function generateCommunitySkills(repoPath: string, opts: GenerateOptions): number {
  // #466: Only clean auto-generated files, preserve user customizations
  const skillsDir = join(repoPath, '.astrolabe', 'skills');
  const generatedDir = join(skillsDir, 'generated');

  if (existsSync(generatedDir)) {
    rmSync(generatedDir, { recursive: true, force: true });
  }
  mkdirSync(generatedDir, { recursive: true });

  const graph = opts.graph!;

  // ── Build indexes for O(1) lookup ──

  // memberId → communityData (#631)
  const communityNodes = new Map<string, CommunityData>();
  for (const node of graph.iterNodes()) {
    if (node.label === 'Community') {
      const name = (node.properties.name as string) ?? node.id;
      communityNodes.set(node.id, {
        name,
        id: node.id,
        cohesion: (node.properties.cohesion as number) ?? 0,
        symbolCount: (node.properties.symbolCount as number) ?? 0,
        members: [],
        entryPoints: [],
        keySymbols: [],
        keyFiles: [],
        processes: [],
        crossCommunityLinks: [],
      });
    }
  }

  // memberId → communityId (#336)
  const memberToCommunity = new Map<string, string>();
  // communityId → memberIds
  const communityMemberIds = new Map<string, Set<string>>();

  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'MEMBER_OF') {
      memberToCommunity.set(rel.sourceId, rel.targetId);
      if (!communityMemberIds.has(rel.targetId)) communityMemberIds.set(rel.targetId, new Set());
      communityMemberIds.get(rel.targetId)!.add(rel.sourceId);
    }
  }

  // Collect members per community with metadata (#631)
  for (const node of graph.iterNodes()) {
    if (!['Function', 'Class', 'Method', 'Interface'].includes(node.label)) continue;
    const cId = memberToCommunity.get(node.id);
    if (!cId) continue;
    const cd = communityNodes.get(cId);
    if (!cd) continue;
    cd.members.push({
      id: node.id,
      label: node.label,
      name: (node.properties.name as string) ?? node.id,
      filePath: (node.properties.filePath as string) ?? '?',
    });
  }

  // ── Enrich with entry points (#631) ──

  for (const rel of graph.iterRelationshipsByType('ENTRY_POINT_OF')) {
    const cId = memberToCommunity.get(rel.sourceId);
    if (!cId) continue;
    const cd = communityNodes.get(cId);
    if (!cd) continue;
    const sym = graph.getNode(rel.sourceId);
    if (sym) {
      cd.entryPoints.push({
        name: (sym.properties.name as string) ?? sym.id,
        label: sym.label,
        filePath: (sym.properties.filePath as string) ?? '?',
      });
    }
  }

  // ── Key symbols: members with most intra-cluster connections (#631) ──

  for (const [cId, mIds] of communityMemberIds) {
    const cd = communityNodes.get(cId);
    if (!cd) continue;
    const connCount = new Map<string, number>();
    for (const rel of graph.iterRelationships()) {
      if (rel.type === 'MEMBER_OF' || rel.type === 'ENTRY_POINT_OF' || rel.type === 'STEP_IN_PROCESS') continue;
      if (mIds.has(rel.sourceId) && mIds.has(rel.targetId)) {
        connCount.set(rel.sourceId, (connCount.get(rel.sourceId) ?? 0) + 1);
        connCount.set(rel.targetId, (connCount.get(rel.targetId) ?? 0) + 1);
      }
    }
    cd.keySymbols = Array.from(connCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count]) => {
        const sym = graph.getNode(id);
        return { name: sym?.properties.name ?? id ?? id, connections: count };
      });
  }

  // ── Key files: aggregate filePaths from members (#631) ──

  for (const cd of communityNodes.values()) {
    const fileMap = new Map<string, number>();
    for (const m of cd.members) {
      if (m.filePath && m.filePath !== '?') {
        fileMap.set(m.filePath, (fileMap.get(m.filePath) ?? 0) + 1);
      }
    }
    cd.keyFiles = Array.from(fileMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, symbolCount]) => ({ path, symbolCount }));
  }

  // ── Processes that include community members (#631) ──

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Process') continue;
    const processName = (node.properties.name as string) ?? node.id;
    const processType = (node.properties.processType as string) ?? 'intra';
    const stepCount = (node.properties.stepCount as number) ?? 0;
    // Check if any STEP_IN_PROCESS involves community members
    for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
      if (rel.targetId === node.id) {
        const cId = memberToCommunity.get(rel.sourceId);
        if (!cId) continue;
        const cd = communityNodes.get(cId);
        if (cd && !cd.processes.some((p) => p.name === processName)) {
          cd.processes.push({ name: processName, type: processType, steps: stepCount });
        }
      }
    }
  }

  // ── Cross-community connections (#631) ──

  const couplingTypes = new Set(['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'FETCHES']);
  for (const rel of graph.iterRelationships()) {
    if (!couplingTypes.has(rel.type)) continue;
    const srcCommunity = memberToCommunity.get(rel.sourceId);
    const tgtCommunity = memberToCommunity.get(rel.targetId);
    if (!srcCommunity || !tgtCommunity || srcCommunity === tgtCommunity) continue;

    const srcSym = graph.getNode(rel.sourceId);
    const srcCd = communityNodes.get(srcCommunity);
    const tgtCd = communityNodes.get(tgtCommunity);
    if (!srcSym || !srcCd || !tgtCd) continue;

    // Outbound: this community calls another
    srcCd.crossCommunityLinks.push({
      direction: 'outbound',
      target: tgtCd.name,
      symbol: (srcSym.properties.name as string) ?? srcSym.id,
      edgeType: rel.type,
    });

    // Inbound: another community calls into this one
    const tgtSym = graph.getNode(rel.targetId);
    if (tgtSym) {
      tgtCd.crossCommunityLinks.push({
        direction: 'inbound',
        target: srcCd.name,
        symbol: (tgtSym.properties.name as string) ?? tgtSym.id,
        edgeType: rel.type,
      });
    }
  }

  // ── Generate rich SKILL.md per community (#631) ──

  let count = 0;
  for (const cd of communityNodes.values()) {
    if (cd.members.length === 0) continue;

    const safeName = cd.name.replace(/[^a-zA-Z0-9_-]/g, '_');

    const lines: string[] = [
      `# ${cd.name} — Module Skill`,
      ``,
      `**Generated by Astrolabe** | **Repo**: \`${opts.repoName}\` | **Cohesion**: ${cd.cohesion.toFixed(2)}`,
      ``,
      `## Overview`,
      ``,
      `The **${cd.name}** module contains ${cd.members.length} symbols across ${cd.keyFiles.length} file${cd.keyFiles.length === 1 ? '' : 's'}.`,
      cd.cohesion > 0.5 ? `High internal cohesion (${cd.cohesion.toFixed(2)}) — symbols are tightly coupled.` : cd.cohesion > 0.2 ? `Moderate cohesion (${cd.cohesion.toFixed(2)}) — some symbols are loosely related.` : `Low cohesion (${cd.cohesion.toFixed(2)}) — symbols may belong to different concerns.`,
    ];

    // ── Key Files ──
    if (cd.keyFiles.length > 0) {
      lines.push('', '## Key Files', '');
      for (const f of cd.keyFiles) {
        lines.push(`- \`${f.path}\` (${f.symbolCount} symbol${f.symbolCount === 1 ? '' : 's'})`);
      }
    }

    // ── Entry Points ──
    lines.push('', '## Entry Points', '');
    if (cd.entryPoints.length > 0) {
      for (const ep of cd.entryPoints) {
        lines.push(`- **${ep.name}** (${ep.label}) — \`${ep.filePath}\``);
      }
    } else {
      lines.push('_No entry points detected for this community._');
    }

    // ── Key Symbols ──
    if (cd.keySymbols.length > 0) {
      lines.push('', '## Key Symbols', '');
      for (const ks of cd.keySymbols) {
        lines.push(`- \`${ks.name}\` (${ks.connections} connections)`);
      }
    }

    // ── Processes ──
    if (cd.processes.length > 0) {
      lines.push('', '## Execution Flows', '');
      for (const proc of cd.processes.slice(0, 10)) {
        lines.push(`- **${proc.name}** (${proc.type}, ${proc.steps} steps)`);
      }
      if (cd.processes.length > 10) {
        lines.push(`- _…and ${cd.processes.length - 10} more_`);
      }
    }

    // ── Cross-Community Connections ──
    if (cd.crossCommunityLinks.length > 0) {
      lines.push('', '## Cross-Community Connections', '');
      // Deduplicate: show unique target communities with link count
      const outbound = cd.crossCommunityLinks.filter((l) => l.direction === 'outbound');
      const inbound = cd.crossCommunityLinks.filter((l) => l.direction === 'inbound');

      if (outbound.length > 0) {
        lines.push(`**Depends on**:`);
        const byTarget = new Map<string, { count: number; types: Set<string> }>();
        for (const l of outbound) {
          if (!byTarget.has(l.target)) byTarget.set(l.target, { count: 0, types: new Set() });
          byTarget.get(l.target)!.count++;
          byTarget.get(l.target)!.types.add(l.edgeType);
        }
        for (const [target, data] of byTarget) {
          lines.push(`- \`${target}\` (${data.count} link${data.count === 1 ? '' : 's'} via ${Array.from(data.types).join(', ')})`);
        }
      }

      if (inbound.length > 0) {
        lines.push(`**Consumed by**:`);
        const bySource = new Map<string, { count: number; types: Set<string> }>();
        for (const l of inbound) {
          if (!bySource.has(l.target)) bySource.set(l.target, { count: 0, types: new Set() });
          bySource.get(l.target)!.count++;
          bySource.get(l.target)!.types.add(l.edgeType);
        }
        for (const [source, data] of bySource) {
          lines.push(`- \`${source}\` (${data.count} link${data.count === 1 ? '' : 's'} via ${Array.from(data.types).join(', ')})`);
        }
      }
    }

    // ── All Members ──
    lines.push('', `## All Members (${cd.members.length})`, '');
    for (const m of cd.members.slice(0, 30)) {
      lines.push(`- ${m.label.padEnd(12)} \`${m.name}\` — \`${m.filePath}\``);
    }
    if (cd.members.length > 30) {
      lines.push(`- _…and ${cd.members.length - 30} more_`);
    }

    // ── How to Navigate ──
    lines.push('', '## How to Navigate', '',
      'Use these MCP tools:',
      `- \`astrolabe.query {"query": "<symbol>"}\` — search symbols`,
      `- \`astrolabe.context {"name": "<symbol>"}\` — full 360° view`,
      `- \`astrolabe.impact {"target": "<symbol>"}\` — blast radius analysis`,
      `- \`astrolabe.detect_changes {"scope": "unstaged"}\` — pre-commit impact`,
    );

    const skillPath = join(generatedDir, `${safeName}.md`);
    atomicWrite(skillPath, lines.join('\n'));
    count++;
  }

  return count;
}
