/**
 * Diff-aware change detection for detect-changes command.
 *
 * Phase 1: Line-level precision — parse diff hunks, map to symbols.
 * Phase 2: Graph delta detection — parse old file versions, diff subgraphs.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeGraph } from '../core/types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type ChangeType = 'added' | 'removed' | 'modified';

export interface AffectedSymbol {
  nodeId: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  label: string;
  changeType: ChangeType;
}

export interface ChangedFileLines {
  [filePath: string]: {
    addedLines: Set<number>;
    removedLines: Set<number>;
  };
}

export interface DetectChangesResult {
  changed_files: string[];
  changed_count: number;
  affected_symbols: AffectedSymbol[];
  affected_count: number;
  affected_processes: string[];
  cross_community_affected: number;
  risk_level: 'none' | 'low' | 'unknown' | 'medium' | 'high';
  graph_delta?: GraphDelta;
  delta_impact?: DeltaImpact;
}

// ── Phase 2: Graph Delta ───────────────────────────────────────────────────

export interface RelationshipDelta {
  type: string;
  sourceName: string;
  targetName: string;
  changeType: 'added' | 'removed';
}

export interface ImportDelta {
  source: string;
  names: { name: string; isDefault: boolean }[];
  changeType: 'added' | 'removed';
}

export interface FileDelta {
  filePath: string;
  addedSymbols: string[];
  removedSymbols: string[];
  addedRelationships: RelationshipDelta[];
  removedRelationships: RelationshipDelta[];
  addedImports: ImportDelta[];
  removedImports: ImportDelta[];
}

export interface GraphDelta {
  files: FileDelta[];
  totalAddedSymbols: number;
  totalRemovedSymbols: number;
  totalAddedRelationships: number;
  totalRemovedRelationships: number;
  totalAddedImports: number;
  totalRemovedImports: number;
}

// ── Phase 3: Delta Impact (blast radius from delta) ────────────────────────

export interface SymbolImpact {
  symbolName: string;
  filePath: string;
  changeType: ChangeType;
  upstreamCallers: string[];
  downstreamCallees: string[];
}

export interface DeltaImpact {
  symbols: SymbolImpact[];
  maxImpactSymbol: string | null;
}

/**
 * Compute blast-radius impact for delta symbols using existing graph edges.
 *
 * For each affected symbol, finds:
 * - Upstream: callers (nodes with CALLS edges targeting this symbol)
 * - Downstream: callees (nodes this symbol CALLS)
 *
 * @param graph Full knowledge graph
 * @param symbols Affected symbols from Phase 1
 * @param maxSymbols Cap on symbols to analyze for performance
 */
export function detectDeltaImpact(
  graph: KnowledgeGraph,
  symbols: AffectedSymbol[],
  maxSymbols = 30,
): DeltaImpact {
  const results: SymbolImpact[] = [];

  for (const sym of symbols.slice(0, maxSymbols)) {
    const upstream: string[] = [];
    const downstream: string[] = [];

    // Find upstream callers via incoming CALLS edges
    for (const rel of graph.iterRelationships()) {
      if (rel.type !== 'CALLS' && rel.type !== 'IMPORTS') continue;
      if (rel.targetId === sym.nodeId) {
        const caller = graph.getNode(rel.sourceId);
        if (caller) upstream.push(caller.properties.name as string ?? caller.id);
      }
      if (rel.sourceId === sym.nodeId) {
        const callee = graph.getNode(rel.targetId);
        if (callee) downstream.push(callee.properties.name as string ?? callee.id);
      }
    }

    if (upstream.length > 0 || downstream.length > 0) {
      results.push({
        symbolName: sym.name,
        filePath: sym.filePath,
        changeType: sym.changeType,
        upstreamCallers: upstream.slice(0, 10),
        downstreamCallees: downstream.slice(0, 10),
      });
    }
  }

  // Find the symbol with highest impact
  let maxImpact: SymbolImpact | null = null;
  let maxCount = 0;
  for (const r of results) {
    const count = r.upstreamCallers.length + r.downstreamCallees.length;
    if (count > maxCount) { maxCount = count; maxImpact = r; }
  }

  return {
    symbols: results,
    maxImpactSymbol: maxImpact ? `${maxImpact.symbolName} (${maxCount} edges)` : null,
  };
}

// ── Diff Parsing ───────────────────────────────────────────────────────────

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff -U0` output to extract actual changed line numbers per file.
 *
 * Walks each hunk's old/new line counters to compute precise line numbers
 * for every added/removed line.
 */
export function parseUnifiedDiffWithLineNumbers(diffOutput: string): ChangedFileLines {
  const result: ChangedFileLines = {};
  const lines = diffOutput.split('\n');

  let currentFile = '';
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const targetMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (targetMatch) {
      currentFile = targetMatch[1];
      result[currentFile] = { addedLines: new Set(), removedLines: new Set() };
      inHunk = false;
      continue;
    }

    if (!currentFile) continue;

    const hunkMatch = line.match(hunkHeader);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[3], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      result[currentFile].addedLines.add(newLine);
      newLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      result[currentFile].removedLines.add(oldLine);
      oldLine++;
    } else if (line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
    // Skip other lines (\ No newline, etc.)
  }

  return result;
}

// ── Phase 2: Graph Delta Detection ─────────────────────────────────────────

const MAX_GRAPH_DELTA_FILES = 20;

async function getOldContent(repoPath: string, filePath: string): Promise<string | null> {
  try {
    return execFileSync('git', ['show', `HEAD:${filePath}`], {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return null; // new file (not in HEAD) or binary
  }
}

async function getNewContent(repoPath: string, filePath: string): Promise<string> {
  return readFileSync(join(repoPath, filePath), 'utf-8');
}

/**
 * Detect relationship deltas by parsing old (HEAD) and new (working tree)
 * versions of changed files. Uses in-memory `parseString` to avoid
 * filesystem writes and graph persistence.
 */
export async function detectGraphDelta(
  repoPath: string,
  wasmDir: string,
  changedFiles: string[],
): Promise<GraphDelta> {
  const { parseString, languageForFile, initParser } = await import('./parser.js');

  // Ensure parser WASM is loaded (no-op if already initialised)
  try { await initParser(); } catch { /* already initialised */ }

  const files = changedFiles.slice(0, MAX_GRAPH_DELTA_FILES);
  const fileDeltas: FileDelta[] = [];

  let totalAddedSym = 0;
  let totalRemovedSym = 0;
  let totalAddedRel = 0;
  let totalRemovedRel = 0;
  let totalAddedImp = 0;
  let totalRemovedImp = 0;

  for (const relPath of files) {
    if (!languageForFile(relPath)) continue; // unsupported extension

    const oldContent = await getOldContent(repoPath, relPath);
    const newContent = await getNewContent(repoPath, relPath);

    if (oldContent === null && newContent.length === 0) continue;

    const oldResult = oldContent !== null
      ? await parseString(oldContent, relPath, wasmDir)
      : null;

    const newResult = await parseString(newContent, relPath, wasmDir);

    if (oldResult?.error || newResult.error) continue; // parse failure

    // Diff symbols
    const oldSymbols = new Set((oldResult?.symbols ?? []).map(s => s.id));
    const newSymbols = new Set(newResult.symbols.map(s => s.id));
    const addedSymbols = newResult.symbols.filter(s => !oldSymbols.has(s.id)).map(s => `${s.label}:${s.name}`);
    const removedSymbols = (oldResult?.symbols ?? []).filter(s => !newSymbols.has(s.id)).map(s => `${s.label}:${s.name}`);

    // Diff relationships (EXTENDS, IMPLEMENTS, DECORATES)
    const oldRelSet = new Set((oldResult?.relationships ?? []).map(r => `${r.sourceName}|${r.targetName}|${r.type}`));
    const newRelSet = new Set(newResult.relationships.map(r => `${r.sourceName}|${r.targetName}|${r.type}`));

    const addedRelationships: RelationshipDelta[] = newResult.relationships
      .filter(r => !oldRelSet.has(`${r.sourceName}|${r.targetName}|${r.type}`))
      .map(r => ({ type: r.type, sourceName: r.sourceName, targetName: r.targetName, changeType: 'added' as const }));

    const removedRelationships: RelationshipDelta[] = (oldResult?.relationships ?? [])
      .filter(r => !newRelSet.has(`${r.sourceName}|${r.targetName}|${r.type}`))
      .map(r => ({ type: r.type, sourceName: r.sourceName, targetName: r.targetName, changeType: 'removed' as const }));

    // Diff imports
    const oldImpSet = new Set((oldResult?.imports ?? []).map(i => i.source));
    const newImpSet = new Set(newResult.imports.map(i => i.source));

    const addedImports: ImportDelta[] = newResult.imports
      .filter(i => !oldImpSet.has(i.source))
      .map(i => ({ source: i.source, names: i.names, changeType: 'added' as const }));

    const removedImports: ImportDelta[] = (oldResult?.imports ?? [])
      .filter(i => !newImpSet.has(i.source))
      .map(i => ({ source: i.source, names: i.names, changeType: 'removed' as const }));

    // Only include files with actual changes
    if (addedSymbols.length > 0 || removedSymbols.length > 0 ||
        addedRelationships.length > 0 || removedRelationships.length > 0 ||
        addedImports.length > 0 || removedImports.length > 0) {
      fileDeltas.push({
        filePath: relPath,
        addedSymbols,
        removedSymbols,
        addedRelationships,
        removedRelationships,
        addedImports,
        removedImports,
      });
    }

    totalAddedSym += addedSymbols.length;
    totalRemovedSym += removedSymbols.length;
    totalAddedRel += addedRelationships.length;
    totalRemovedRel += removedRelationships.length;
    totalAddedImp += addedImports.length;
    totalRemovedImp += removedImports.length;
  }

  return {
    files: fileDeltas,
    totalAddedSymbols: totalAddedSym,
    totalRemovedSymbols: totalRemovedSym,
    totalAddedRelationships: totalAddedRel,
    totalRemovedRelationships: totalRemovedRel,
    totalAddedImports: totalAddedImp,
    totalRemovedImports: totalRemovedImp,
  };
}

// ── Symbol Mapping ─────────────────────────────────────────────────────────

/**
 * Find symbols affected by line-level changes in a diff.
 *
 * For each changed file, checks whether any symbol's line range
 * overlaps with added or removed lines.
 *
 * @param graph Populated knowledge graph
 * @param changedLines Line-level changes per file from `parseUnifiedDiffWithLineNumbers`
 * @returns Symbols affected by the diff, with change type
 */
export function findAffectedSymbols(
  graph: KnowledgeGraph,
  changedLines: ChangedFileLines,
): AffectedSymbol[] {
  const affected: AffectedSymbol[] = [];

  for (const node of graph.iterNodes()) {
    const fp = node.properties.filePath as string | undefined;
    if (!fp) continue;

    const changes = changedLines[fp];
    if (!changes) continue;

    const startLine = (node.properties.startLine as number) ?? 0;
    const endLine = (node.properties.endLine as number) ?? startLine;

    if (startLine === 0) continue; // no line info, skip

    // Check if any changed line falls within the symbol's range
    let changeType: ChangeType | null = null;

    for (const line of changes.removedLines) {
      if (line >= startLine && line <= endLine) {
        changeType = 'removed';
        break;
      }
    }

    if (!changeType) {
      for (const line of changes.addedLines) {
        if (line >= startLine && line <= endLine) {
          changeType = 'added';
          break;
        }
      }
    }

    if (!changeType) {
      // Check if any line was both added and removed in the same range → modified
      const gotAdded = [...changes.addedLines].some(l => l >= startLine && l <= endLine);
      const gotRemoved = [...changes.removedLines].some(l => l >= startLine && l <= endLine);
      if (gotAdded && gotRemoved) {
        changeType = 'modified';
      } else if (gotAdded) {
        changeType = 'added';
      } else if (gotRemoved) {
        changeType = 'removed';
      }
    }

    if (changeType) {
      affected.push({
        nodeId: node.id,
        name: (node.properties.name as string) ?? node.id,
        filePath: fp,
        startLine,
        endLine,
        label: node.label,
        changeType,
      });
    }
  }

  return affected;
}

// ── Main Orchestrator ──────────────────────────────────────────────────────

/**
 * Run diff-aware change detection for a repository.
 *
 * Phase 1: Line-level precision — git diff with line numbers,
 * mapped to symbols by startLine/endLine range overlap.
 * Falls back to file-level behaviour when diff parsing fails.
 *
 * @param graph Populated knowledge graph
 * @param repoPath Path to the git repository
 * @param scope Diff scope: unstaged, staged, or all
 * @returns Detection result with affected symbols and processes
 */
export function detectChanges(
  graph: KnowledgeGraph,
  repoPath: string,
  scope: 'unstaged' | 'staged' | 'all' = 'unstaged',
): DetectChangesResult {
  const validScopes = ['unstaged', 'staged', 'all'];
  const resolvedScope = validScopes.includes(scope) ? scope : 'unstaged';

  // Run git diff --name-only for file list
  const diffFlag = resolvedScope === 'staged' ? '--cached' : resolvedScope === 'all' ? 'HEAD' : '';
  const nameArgs = ['diff', '--name-only'];
  if (diffFlag) nameArgs.push(diffFlag);

  let diffFiles: string[] = [];
  try {
    const output = execFileSync('git', nameArgs, { cwd: repoPath, encoding: 'utf-8' });
    diffFiles = output.trim().split('\n').filter(Boolean);
  } catch {
    return {
      changed_files: [],
      changed_count: 0,
      affected_symbols: [],
      affected_count: 0,
      affected_processes: [],
      cross_community_affected: 0,
      risk_level: 'none',
    };
  }

  if (diffFiles.length === 0) {
    return {
      changed_files: [],
      changed_count: 0,
      affected_symbols: [],
      affected_count: 0,
      affected_processes: [],
      cross_community_affected: 0,
      risk_level: 'none',
    };
  }

  // Phase 1: Parse git diff -U0 for line-level precision
  let affectedSymbols: AffectedSymbol[] = [];
  const diffFileSet = new Set(diffFiles);

  try {
    const lineArgs = ['diff', '-U0'];
    if (diffFlag) lineArgs.push(diffFlag);
    const diffOutput = execFileSync('git', lineArgs, { cwd: repoPath, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    const changedLines = parseUnifiedDiffWithLineNumbers(diffOutput);
    affectedSymbols = findAffectedSymbols(graph, changedLines);

    // Files with no line-level mapping: fall back to all symbols
    const mappedFiles = new Set(affectedSymbols.map(s => s.filePath));
    for (const file of diffFiles) {
      if (!mappedFiles.has(file)) {
        for (const node of graph.iterNodes()) {
          const fp = node.properties.filePath as string | undefined;
          if (fp === file) {
            affectedSymbols.push({
              nodeId: node.id,
              name: (node.properties.name as string) ?? node.id,
              filePath: fp,
              startLine: (node.properties.startLine as number) ?? 0,
              endLine: (node.properties.endLine as number) ?? 0,
              label: node.label,
              changeType: 'modified',
            });
          }
        }
      }
    }
  } catch {
    // Fallback: file-level detection (all symbols in changed files)
    for (const node of graph.iterNodes()) {
      const fp = node.properties.filePath as string | undefined;
      if (fp && diffFileSet.has(fp)) {
        affectedSymbols.push({
          nodeId: node.id,
          name: (node.properties.name as string) ?? node.id,
          filePath: fp,
          startLine: (node.properties.startLine as number) ?? 0,
          endLine: (node.properties.endLine as number) ?? 0,
          label: node.label,
          changeType: 'modified',
        });
      }
    }
  }

  // Find affected processes
  const changedNodeIds = new Set(affectedSymbols.map(s => s.nodeId));
  const affectedProcesses: string[] = [];
  const seenProcessNames = new Set<string>();

  for (const rel of graph.iterRelationshipsByType('STEP_IN_PROCESS')) {
    if (changedNodeIds.has(rel.targetId)) {
      const proc = graph.getNode(rel.sourceId);
      if (proc) {
        const procName = proc.properties.name ?? proc.id;
        if (!seenProcessNames.has(procName)) {
          seenProcessNames.add(procName);
          affectedProcesses.push(procName);
        }
      }
    }
  }

  const crossCommunityCount = affectedProcesses.length;
  const riskLevel = affectedProcesses.length > 3 ? 'high'
    : affectedProcesses.length > 0 ? 'medium'
    : changedNodeIds.size > 0 ? 'unknown'
    : 'low';

  const deltaImpact = affectedSymbols.length > 0
    ? detectDeltaImpact(graph, affectedSymbols)
    : { symbols: [], maxImpactSymbol: null };

  return {
    changed_files: diffFiles,
    changed_count: diffFiles.length,
    affected_symbols: affectedSymbols,
    affected_count: affectedProcesses.length,
    affected_processes: affectedProcesses,
    cross_community_affected: crossCommunityCount,
    risk_level: riskLevel,
    delta_impact: deltaImpact,
  };
}
