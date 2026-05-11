/**
 * VSCode Extension — Astrolabe Codebase Explorer.
 *
 * Full integration: analyze codebase, explore the knowledge graph,
 * search symbols, inspect context, and trace impact.
 *
 * Registration in packages/vscode/package.json.
 */

import * as vscode from 'vscode';
import type { KnowledgeGraph } from '@astrolabe-dev/core';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  initParser,
  createKnowledgeGraph,
  createPhaseContext,
  runPipeline,
  scanPhase, structurePhase, frameworkPhase, markdownPhase, parseEmitPhase,
  resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase,
  mroPhase, communityPhase, processTracingPhase, accessTrackingPhase,
  createSqliteStore, createFtsSearch,
  loadRegistry, saveRegistry,
  createLogger,
} from '@astrolabe-dev/core';
import { showGraphPanel } from './webview';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getGitCommit(repoPath: string): string {
  try { return execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim(); }
  catch { return 'unknown'; }
}

function dbPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.astrolabe', 'astrolabe.db');
}

function ensureDbDir(db: string): void {
  const dir = dirname(db);
  if (dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// #244: Shared adjacency index builder — DRY, used by context, impact, and MCP
type AdjEntry = { id: string; type: string; dir: 'in' | 'out' };
type AdjIndex = Map<string, AdjEntry[]>;

function buildAdjacencyIndex(graph: KnowledgeGraph): AdjIndex {
  const adj: AdjIndex = new Map();
  for (const rel of graph.iterRelationships()) {
    let b = adj.get(rel.sourceId);
    if (!b) { b = []; adj.set(rel.sourceId, b); }
    b.push({ id: rel.targetId, type: rel.type, dir: 'out' });
    b = adj.get(rel.targetId);
    if (!b) { b = []; adj.set(rel.targetId, b); }
    b.push({ id: rel.sourceId, type: rel.type, dir: 'in' });
  }
  return adj;
}

// ── Per-workspace state (#236: multi-root workspace support) ─────────────────

interface WorkspaceState {
  analyzing: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  lastHead: string;
  /** #244: cached loaded graph, invalidated on re-analysis */
  cachedGraph: KnowledgeGraph | null;
  cachedAdj: AdjIndex | null;
}

const SAVE_DEBOUNCE_MS = 30_000;
const HEAD_POLL_MS = 60_000;

const ws = new Map<string, WorkspaceState>();

function getWs(repoPath: string): WorkspaceState {
  let state = ws.get(repoPath);
  if (!state) {
    state = { analyzing: false, debounceTimer: null, lastHead: '', cachedGraph: null, cachedAdj: null };
    ws.set(repoPath, state);
  }
  return state;
}

// ── Status bar ───────────────────────────────────────────────────────────────

let statusBarItem: vscode.StatusBarItem;

function createStatusBar(): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'astrolabe.analyze';
  refreshStatusBar();
  statusBarItem.show();
}

function refreshStatusBar(workspaceRoot?: string): void {
  if (!workspaceRoot) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { statusBarItem.text = '$(graph) Astrolabe: no workspace'; return; }
    workspaceRoot = folder.uri.fsPath;
  }
  const db = dbPath(workspaceRoot);
  if (!existsSync(db)) {
    statusBarItem.text = '$(graph) Astrolabe: not analyzed';
    statusBarItem.tooltip = 'Click to analyze codebase';
    statusBarItem.command = 'astrolabe.analyze';
    return;
  }
  try {
    const repos = loadRegistry();
    const repo = repos.find((r) => r.path === workspaceRoot);
    if (repo) {
      const currentCommit = getGitCommit(workspaceRoot);
      if (repo.lastCommit !== currentCommit) {
        statusBarItem.text = '$(warning) Astrolabe: stale';
        statusBarItem.tooltip = 'Graph is stale — click to re-analyze';
        statusBarItem.command = 'astrolabe.analyze';
        return;
      }
    }
    const store = createSqliteStore(db);
    try {
      const count = store.getNodeCount();
      statusBarItem.text = `$(graph) Astrolabe: ${count} nodes`;
      statusBarItem.tooltip = `Knowledge graph: ${count} nodes. Click to view.`;
      statusBarItem.command = 'astrolabe.showGraph';
    } finally { store.close(); }
  } catch {
    statusBarItem.text = '$(graph) Astrolabe: not analyzed';
    statusBarItem.tooltip = 'Click to analyze codebase';
    statusBarItem.command = 'astrolabe.analyze';
  }
}

// ── Core analysis (shared by auto-start and manual command) ───────────────────

async function runAnalysis(
  repoPath: string,
  progress: vscode.Progress<{ message: string }> | null,
  silent: boolean,
): Promise<void> {
  const state = getWs(repoPath);
  if (state.analyzing) return;
  state.analyzing = true;
  const db = dbPath(repoPath);
  const log = createLogger({ level: 'info' });

  statusBarItem.text = '$(sync~spin) Astrolabe: analyzing...';
  statusBarItem.tooltip = 'Analysis in progress';
  statusBarItem.command = undefined;

  try {
    if (progress) progress.report({ message: 'Initializing parser...' });
    await initParser();

    if (progress) progress.report({ message: 'Scanning files...' });
    const graph = createKnowledgeGraph();
    const phaseCtx = createPhaseContext(repoPath, graph, () => undefined);

    if (progress) progress.report({ message: 'Running analysis pipeline (13 phases)...' });
    await runPipeline([
      scanPhase, structurePhase, frameworkPhase, markdownPhase, parseEmitPhase,
      resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase,
      mroPhase, communityPhase, processTracingPhase, accessTrackingPhase,
    ], phaseCtx);

    if (progress) progress.report({ message: 'Persisting to SQLite...' });
    ensureDbDir(db);
    const store = createSqliteStore(db);
    store.saveGraph(graph);
    const nodeCount = graph.nodeCount;
    const edgeCount = graph.relationshipCount;

    if (progress) progress.report({ message: 'Building search index...' });
    const fts = createFtsSearch(db);
    fts.indexGraph(store);
    fts.close();
    store.close();

    if (progress) progress.report({ message: 'Registering repo...' });
    const repos = loadRegistry();
    const repoName = basename(repoPath);
    const entry = {
      name: repoName, path: repoPath, dbPath: db,
      lastCommit: getGitCommit(repoPath), indexedAt: Date.now(),
    };
    const existingIdx = repos.findIndex((r) => r.path === repoPath);
    if (existingIdx >= 0) repos[existingIdx] = entry; else repos.push(entry);
    saveRegistry(repos);

    // #216: Sync lastHead after successful analysis so HEAD polling doesn't double-fire
    state.lastHead = getGitCommit(repoPath);

    // #244: Invalidate cached graph so next command loads fresh data
    state.cachedGraph = null;
    state.cachedAdj = null;

    log.info('Analysis complete', { nodes: nodeCount, edges: edgeCount });
    if (!silent) {
      vscode.window.showInformationMessage(
        `Astrolabe: Analysis complete — ${nodeCount} nodes, ${edgeCount} edges.`
      );
    }
  } catch (err) {
    log.error('Analysis failed', { error: String(err) });
    if (!silent) {
      vscode.window.showErrorMessage(`Astrolabe: Analysis failed — ${String(err)}`);
    }
  } finally {
    state.analyzing = false;
    refreshStatusBar(repoPath);
  }
}

// #244: Load graph from DB with memory cache — avoids reloading on every command
function loadGraphCached(repoPath: string): { graph: KnowledgeGraph; adj: AdjIndex } {
  const state = getWs(repoPath);
  if (state.cachedGraph && state.cachedAdj) return { graph: state.cachedGraph, adj: state.cachedAdj };

  const db = dbPath(repoPath);
  const store = createSqliteStore(db);
  try {
    state.cachedGraph = store.loadGraph();
    state.cachedAdj = buildAdjacencyIndex(state.cachedGraph);
  } finally { store.close(); }

  return { graph: state.cachedGraph!, adj: state.cachedAdj! };
}

// ── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  createStatusBar();

  // #313: Cache output channels to prevent creating new ones per invocation
  const outputChannels = {
    context: vscode.window.createOutputChannel('Astrolabe Context'),
    impact: vscode.window.createOutputChannel('Astrolabe Impact'),
  };
  context.subscriptions.push(outputChannels.context, outputChannels.impact);

  // #205: Wire analyze to full core pipeline
  const analyzeCmd = vscode.commands.registerCommand('astrolabe.analyze', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Astrolabe: No workspace folder open.');
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Astrolabe: Analyzing codebase...', cancellable: false },
      async (progress) => runAnalysis(folder.uri.fsPath, progress, false),
    );
  });

  // #206: Graph visualization webview
  const showGraphCmd = vscode.commands.registerCommand('astrolabe.showGraph', () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Astrolabe: No workspace folder open.');
      return;
    }
    const db = dbPath(folder.uri.fsPath);
    if (!existsSync(db)) {
      vscode.window.showWarningMessage('Astrolabe: No analysis found. Run "Astrolabe: Analyze Codebase" first.');
      return;
    }
    showGraphPanel(context, db);
  });

  // #208: Query command
  const queryCmd = vscode.commands.registerCommand('astrolabe.query', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Astrolabe: No workspace folder open.');
      return;
    }
    const repoPath = folder.uri.fsPath;
    const db = dbPath(repoPath);
    if (!existsSync(db)) {
      vscode.window.showWarningMessage('Astrolabe: No analysis found. Run "Astrolabe: Analyze Codebase" first.');
      return;
    }
    const searchTerm = await vscode.window.showInputBox({
      prompt: 'Search the knowledge graph', placeHolder: 'Symbol name, file path, or class name...',
    });
    if (!searchTerm) return;

    const fts = createFtsSearch(db);
    try {
      const results = fts.search(searchTerm, 20);
      if (results.length === 0) {
        vscode.window.showInformationMessage(`No results found for "${searchTerm}".`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        results.map((r) => ({ label: r.name, description: `${r.label} — ${r.filePath}`, detail: r.nodeId })),
        { placeHolder: `Results for "${searchTerm}" (${results.length} found)`, matchOnDescription: true },
      );
      if (picked) {
        const result = results.find((r) => r.nodeId === picked.detail);
        if (result?.filePath) {
          // #299: Prevent path traversal — validate resolved path stays within workspace
          const fullPath = resolve(repoPath, result.filePath);
          if (!fullPath.startsWith(resolve(repoPath) + '/') && fullPath !== resolve(repoPath)) return;
          const uri = vscode.Uri.file(fullPath);
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc);
          try {
            const { graph } = loadGraphCached(repoPath); // #244: use cached graph
            const node = graph.getNode(result.nodeId);
            const line = node?.properties.startLine as number | undefined;
            if (line && line > 0) {
              const pos = new vscode.Position(line - 1, 0);
              editor.selection = new vscode.Selection(pos, pos);
              editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
          } catch { /* skip line navigation on error */ }
        }
      }
    } finally { fts.close(); }
  });

  // #208: Context command — show symbol details in output channel
  const contextCmd = vscode.commands.registerCommand('astrolabe.context', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Astrolabe: No workspace folder open.');
      return;
    }
    const repoPath = folder.uri.fsPath;
    const db = dbPath(repoPath);
    if (!existsSync(db)) {
      vscode.window.showWarningMessage('Astrolabe: No analysis found. Run "Astrolabe: Analyze Codebase" first.');
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const defaultTerm = editor
      ? editor.document.fileName.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? ''
      : '';
    const searchTerm = await vscode.window.showInputBox({
      prompt: 'Show context for symbol', placeHolder: 'Symbol name...', value: defaultTerm,
    });
    if (!searchTerm) return;

    const fts = createFtsSearch(db);
    try {
      const results = fts.search(searchTerm, 10);
      if (results.length === 0) {
        vscode.window.showInformationMessage(`No symbols found for "${searchTerm}".`);
        return;
      }
      const { graph, adj } = loadGraphCached(repoPath); // #244: use cached graph+adj

  const channel = outputChannels.context;
  channel.clear();
      for (const r of results) {
        channel.appendLine(`${'─'.repeat(60)}`);
        channel.appendLine(`${r.label}: ${r.name}`);
        channel.appendLine(`  ID:    ${r.nodeId}`);
        channel.appendLine(`  File:  ${r.filePath}`);
        channel.appendLine('');
        const edges = adj.get(r.nodeId) ?? [];
        for (const e of edges) {
          const other = graph.getNode(e.id);
          const arrow = e.dir === 'in' ? '←' : '→';
          const verb = e.dir === 'in' ? 'from' : 'to';
          channel.appendLine(`  ${arrow} ${e.type} ${verb} ${other?.properties.name ?? e.id}`);
        }
        channel.appendLine('');
      }
      channel.show();
    } finally { fts.close(); }
  });

  // #208: Impact command — trace upstream/downstream impact
  const impactCmd = vscode.commands.registerCommand('astrolabe.impact', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Astrolabe: No workspace folder open.');
      return;
    }
    const repoPath = folder.uri.fsPath;
    const db = dbPath(repoPath);
    if (!existsSync(db)) {
      vscode.window.showWarningMessage('Astrolabe: No analysis found. Run "Astrolabe: Analyze Codebase" first.');
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const defaultTerm = editor
      ? editor.document.fileName.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? ''
      : '';
    const searchTerm = await vscode.window.showInputBox({
      prompt: 'Analyze impact for symbol', placeHolder: 'Symbol or function name...', value: defaultTerm,
    });
    if (!searchTerm) return;

    const { graph, adj } = loadGraphCached(repoPath); // #244: use cached graph+adj

    // Find matching nodes
    const matched: Array<{ node: ReturnType<typeof graph.getNode>; upstream: string[]; downstream: string[] }> = [];
    for (const node of graph.iterNodes()) {
      if (node.properties.name === searchTerm) {
        const n = adj.get(node.id) ?? [];
        const upstream = n.filter((e) => e.dir === 'in').map((e) => {
          const other = graph.getNode(e.id);
          return `${e.type} ← ${other?.properties.name ?? e.id}`;
        });
        const downstream = n.filter((e) => e.dir === 'out').map((e) => {
          const other = graph.getNode(e.id);
          return `${e.type} → ${other?.properties.name ?? e.id}`;
        });
        matched.push({ node, upstream, downstream });
      }
    }

  const channel = outputChannels.impact;
  channel.clear();
    if (matched.length === 0) {
      channel.appendLine(`No symbol found matching "${searchTerm}".`);
    } else {
      for (const { node, upstream, downstream } of matched) {
        channel.appendLine(`${'─'.repeat(60)}`);
        channel.appendLine(`${node!.label}: ${node!.properties.name}  (${node!.properties.filePath})`);
        channel.appendLine('');
        if (upstream.length > 0) {
          channel.appendLine(`Upstream (depends on me): ${upstream.length}`);
          for (const u of upstream) channel.appendLine(`  ${u}`);
          channel.appendLine('');
        }
        if (downstream.length > 0) {
          channel.appendLine(`Downstream (I depend on): ${downstream.length}`);
          for (const d of downstream) channel.appendLine(`  ${d}`);
          channel.appendLine('');
        }
        if (upstream.length === 0 && downstream.length === 0) {
          channel.appendLine('No connected edges found.');
        }
      }
    }
    channel.show();
  });

  context.subscriptions.push(analyzeCmd, showGraphCmd, queryCmd, contextCmd, impactCmd, statusBarItem);

  // ── Live re-analysis triggers ─────────────────────────────────────────────
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const repoPath = folder.uri.fsPath;
  const state = getWs(repoPath);

  // #218: Auto-analyze on startup with progress notification (was silent)
  const db = dbPath(repoPath);
  if (!existsSync(db)) {
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Astrolabe: First-time analysis...', cancellable: false },
      (progress) => runAnalysis(repoPath, progress, false),
    );
  }

  // Trigger: debounced save (30s window batches multiple saves into one re-analysis)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      // #298: Only trigger analysis for files within the workspace being analyzed
      if (!doc.uri.fsPath.startsWith(repoPath)) return;
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        runAnalysis(repoPath, null, true);
      }, SAVE_DEBOUNCE_MS);
    }),
  );

  // #215: Watch .git/HEAD for live stale detection (branch switches, pulls, merges)
  const gitHead = join(repoPath, '.git', 'HEAD');
  if (existsSync(gitHead)) {
    const headWatcher = vscode.workspace.createFileSystemWatcher(gitHead);
    headWatcher.onDidChange(() => refreshStatusBar(repoPath));
    headWatcher.onDidCreate(() => refreshStatusBar(repoPath));
    context.subscriptions.push(headWatcher);
  }

  // Trigger: git HEAD polling (catches branch switches, pulls, merges)
  state.lastHead = getGitCommit(repoPath);
  const headInterval = setInterval(() => {
    const currentHead = getGitCommit(repoPath);
    if (currentHead !== 'unknown' && currentHead !== state.lastHead) {
      state.lastHead = currentHead;
      runAnalysis(repoPath, null, true);
    }
  }, HEAD_POLL_MS);

  context.subscriptions.push({ dispose: () => clearInterval(headInterval) });
}

export function deactivate(): void {
  // #247: Clean up pending debounce timers across all workspaces
  for (const state of ws.values()) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
  }
}
