/**
 * Diff-aware change detection for detect-changes command.
 *
 * Replaces the old file-level approach (all symbols in changed files)
 * with line-level precision using `git diff -U0` output.
 *
 * Phase 1: Line-level precision — parse diff hunks, map to symbols.
 */

import { execFileSync } from 'node:child_process';
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

  return {
    changed_files: diffFiles,
    changed_count: diffFiles.length,
    affected_symbols: affectedSymbols,
    affected_count: affectedProcesses.length,
    affected_processes: affectedProcesses,
    cross_community_affected: crossCommunityCount,
    risk_level: riskLevel,
  };
}
