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

// #225: Cap to top 1000 most-connected nodes (regression from #214 D3 rewrite)
const NODE_CAP = 1000;

function serializeGraph(graph: KnowledgeGraph): { nodes: SerializableNode[]; edges: SerializableEdge[] } {
  // Compute degree for every node
  const degree = new Map<string, number>();
  for (const rel of graph.iterRelationships()) {
    degree.set(rel.sourceId, (degree.get(rel.sourceId) ?? 0) + 1);
    degree.set(rel.targetId, (degree.get(rel.targetId) ?? 0) + 1);
  }

  // Take top NODE_CAP by degree
  const allNodes: SerializableNode[] = [];
  for (const node of graph.iterNodes()) {
    allNodes.push({
      id: node.id,
      label: node.label,
      name: (node.properties.name as string) ?? node.id,
      filePath: (node.properties.filePath as string) ?? '',
      startLine: node.properties.startLine as number | undefined,
      endLine: node.properties.endLine as number | undefined,
    });
  }
  allNodes.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
  const capped = allNodes.slice(0, NODE_CAP);

  // Only pass edges between capped nodes
  const capSet = new Set(capped.map((n) => n.id));
  const edges: SerializableEdge[] = [];
  for (const rel of graph.iterRelationships()) {
    if (capSet.has(rel.sourceId) && capSet.has(rel.targetId)) {
      edges.push({ sourceId: rel.sourceId, targetId: rel.targetId, type: rel.type });
    }
  }

  return { nodes: capped, edges };
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
  // #305: Graceful error if webview build output is missing
  let html: string;
  try { html = readFileSync(htmlPath, 'utf-8'); } catch {
    vscode.window.showErrorMessage('Astrolabe: Graph webview not found. Please rebuild (npm run build).');
    return;
  }

  // #303: Allow vscode-webview-resource: for Vite-built external script bundles
  html = html.replace(
    '<head>',
    '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\' vscode-webview-resource:; script-src \'unsafe-inline\' vscode-webview-resource:;">',
  );
  const assetsDir = vscode.Uri.file(join(context.extensionPath, 'dist', 'webview', 'assets'));
  const assetsBase = panel.webview.asWebviewUri(assetsDir).toString();
  html = html.replace(/\.\/assets\//g, assetsBase + '/');
  html = html.replace(/\/assets\//g, assetsBase + '/');

  // #222: Embed graph data in HTML as a global variable.
  // This avoids the postMessage race condition — the webview's init()
  // reads window.graphData immediately, no message listener timing needed.
  // #229: Escape </script> to prevent JSON injection breakout
  const graphJson = JSON.stringify(serializeGraph(graph)).replace(/<\//g, '<\\/');
  html = html.replace(
    '</head>',
    '<script>window.graphData = ' + graphJson + ';</script></head>',
  );

  panel.webview.html = html;
}
