/**
 * VSCode Extension — Astrolabe Codebase Explorer.
 *
 * Full integration: analyze codebase, explore the knowledge graph,
 * search symbols, inspect context, and trace impact.
 *
 * Registration in packages/vscode/package.json.
 */

import * as vscode from 'vscode';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { execSync } from 'node:child_process';
import {
  initParser,
  createKnowledgeGraph,
  createPhaseContext,
  runPipeline,
  scanPhase, structurePhase, frameworkPhase, markdownPhase, parseEmitPhase,
  resolutionPhase, routesPhase, toolsPhase, ormPhase, crossFilePhase,
  mroPhase, communityPhase, processTracingPhase,
  createSqliteStore, createFtsSearch,
  loadRegistry, saveRegistry,
  createLogger,
} from '@astrolabe/core';
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
  }
}

// ── Core analysis (shared by auto-start and manual command) ───────────────────

async function runAnalysis(
  repoPath: string,
  progress: vscode.Progress<{ message: string }> | null,
  silent: boolean,
): Promise<void> {
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
      mroPhase, communityPhase, processTracingPhase,
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

    log.info('Analysis complete', { nodes: nodeCount, edges: edgeCount });
    if (!silent) {
      vscode.window.showInformationMessage(
        `Astrolabe: Analysis complete — ${nodeCount} nodes, ${edgeCount} edges.`
      );
    }
    refreshStatusBar(repoPath);
  } catch (err) {
    log.error('Analysis failed', { error: String(err) });
    refreshStatusBar(repoPath);
    if (!silent) {
      vscode.window.showErrorMessage(`Astrolabe: Analysis failed — ${String(err)}`);
    }
  }
}

// ── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  createStatusBar();

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
    const db = dbPath(folder.uri.fsPath);
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
        const fp = results.find((r) => r.name === picked.label)?.filePath;
        if (fp) {
          const uri = vscode.Uri.file(join(folder.uri.fsPath, fp));
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc);
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
    const db = dbPath(folder.uri.fsPath);
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
      const store = createSqliteStore(db);
      try {
        const graph = store.loadGraph();
        const channel = vscode.window.createOutputChannel('Astrolabe Context');
        channel.clear();
        for (const r of results) {
          channel.appendLine(`${'─'.repeat(60)}`);
          channel.appendLine(`${r.label}: ${r.name}`);
          channel.appendLine(`  ID:    ${r.nodeId}`);
          channel.appendLine(`  File:  ${r.filePath}`);
          channel.appendLine('');
          // Show incoming edges
          for (const rel of graph.iterRelationships()) {
            if (rel.targetId === r.nodeId) {
              const src = graph.getNode(rel.sourceId);
              channel.appendLine(`  ← ${rel.type} from ${src?.properties.name ?? rel.sourceId}`);
            }
          }
          // Show outgoing edges
          for (const rel of graph.iterRelationships()) {
            if (rel.sourceId === r.nodeId) {
              const tgt = graph.getNode(rel.targetId);
              channel.appendLine(`  → ${rel.type} to ${tgt?.properties.name ?? rel.targetId}`);
            }
          }
          channel.appendLine('');
        }
        channel.show();
        store.close();
      } catch { /* skip */ }
    } finally { fts.close(); }
  });

  // #208: Impact command — trace upstream/downstream impact
  const impactCmd = vscode.commands.registerCommand('astrolabe.impact', async () => {
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
    const editor = vscode.window.activeTextEditor;
    const defaultTerm = editor
      ? editor.document.fileName.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? ''
      : '';
    const searchTerm = await vscode.window.showInputBox({
      prompt: 'Analyze impact for symbol', placeHolder: 'Symbol or function name...', value: defaultTerm,
    });
    if (!searchTerm) return;

    const store = createSqliteStore(db);
    try {
      const graph = store.loadGraph();
      // BFS upstream (who calls me) and downstream (who I call)
      const adj = new Map<string, Array<{ id: string; type: string; dir: string }>>();
      for (const rel of graph.iterRelationships()) {
        let b = adj.get(rel.sourceId);
        if (!b) { b = []; adj.set(rel.sourceId, b); }
        b.push({ id: rel.targetId, type: rel.type, dir: 'out' });
        b = adj.get(rel.targetId);
        if (!b) { b = []; adj.set(rel.targetId, b); }
        b.push({ id: rel.sourceId, type: rel.type, dir: 'in' });
      }

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

      const channel = vscode.window.createOutputChannel('Astrolabe Impact');
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
    } finally { store.close(); }
  });

  context.subscriptions.push(analyzeCmd, showGraphCmd, queryCmd, contextCmd, impactCmd, statusBarItem);

  // Auto-analyze on startup if never analyzed — non-blocking, silent on success
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const db = dbPath(folder.uri.fsPath);
    if (!existsSync(db)) {
      runAnalysis(folder.uri.fsPath, null, true);
    }
  }
}

export function deactivate(): void {
  // Cleanup
}
