/**
 * Webview panel provider for the D3-based knowledge graph visualization.
 *
 * Loads a Vite-built webview from dist/webview/ and passes graph data
 * via postMessage. The webview uses D3.js for rendering.
 */

import * as vscode from 'vscode';
import type { KnowledgeGraph } from '@astrolabe/core';
import { createSqliteStore } from '@astrolabe/core';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

interface SerializableNode {
  id: string; label: string; name: string; filePath: string;
  startLine?: number; endLine?: number;
  [key: string]: unknown;
}

interface SerializableEdge {
  sourceId: string; targetId: string; type: string;
}

function serializeGraph(graph: KnowledgeGraph): { nodes: SerializableNode[]; edges: SerializableEdge[] } {
  const nodes: SerializableNode[] = [];
  for (const node of graph.iterNodes()) {
    const n: SerializableNode = {
      id: node.id,
      label: node.label,
      name: (node.properties.name as string) ?? node.id,
      filePath: (node.properties.filePath as string) ?? '',
    };
    if (node.properties.startLine) n.startLine = node.properties.startLine as number;
    if (node.properties.endLine) n.endLine = node.properties.endLine as number;
    nodes.push(n);
  }
  const edges: SerializableEdge[] = [];
  for (const rel of graph.iterRelationships()) {
    edges.push({ sourceId: rel.sourceId, targetId: rel.targetId, type: rel.type });
  }
  return { nodes, edges };
}

// ── Panel provider ───────────────────────────────────────────────────────────

export function showGraphPanel(context: vscode.ExtensionContext, dbPath: string): void {
  const store = createSqliteStore(dbPath);
  let graph: KnowledgeGraph;
  try {
    graph = store.loadGraph();
  } finally { store.close(); }

  const panel = vscode.window.createWebviewPanel(
    'astrolabeGraph',
    'Astrolabe Knowledge Graph',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(join(context.extensionPath, 'dist', 'webview')),
      ],
    },
  );

  // Load built HTML
  const htmlPath = join(context.extensionPath, 'dist', 'webview', 'index.html');
  let html = readFileSync(htmlPath, 'utf-8');

  // Rewrite asset paths to webview URIs
  const assetsDir = vscode.Uri.file(join(context.extensionPath, 'dist', 'webview', 'assets'));
  const assetsBase = panel.webview.asWebviewUri(assetsDir).toString();
  html = html.replace(/\.\/assets\//g, assetsBase + '/');
  html = html.replace(/\/assets\//g, assetsBase + '/');

  panel.webview.html = html;

  // Send graph data
  panel.webview.postMessage({ type: 'graphData', data: serializeGraph(graph) });
}
