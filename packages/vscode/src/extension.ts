/**
 * VSCode Extension — Astrolabe Codebase Explorer.
 *
 * Provides commands to analyze a codebase, explore the knowledge graph,
 * detect code impact, and trace caller relationships.
 *
 * Entry point registered in packages/vscode/package.json.
 */

import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const analyzeCmd = vscode.commands.registerCommand('astrolabe.analyze', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }
    vscode.window.showInformationMessage(`Analyzing ${folder.uri.fsPath}...`);
    // Future: invoke @astrolabe/core pipeline
  });

  const showGraphCmd = vscode.commands.registerCommand('astrolabe.showGraph', () => {
    // Future: open webview with React + xyflow visualization
    vscode.window.showInformationMessage('Knowledge graph visualization coming soon.');
  });

  context.subscriptions.push(analyzeCmd, showGraphCmd);
}

export function deactivate(): void {
  // Cleanup
}
