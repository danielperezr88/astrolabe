/**
 * Webview panel provider for knowledge graph visualization (#206).
 *
 * Renders an SVG force-directed graph of the Astrolabe knowledge graph
 * using vanilla JS — no external dependencies.
 */

import * as vscode from 'vscode';
import type { KnowledgeGraph } from '@astrolabe/core';
import { createSqliteStore } from '@astrolabe/core';

// ── Serialisation ────────────────────────────────────────────────────────────

interface SerializableNode {
  id: string; label: string; name: string; filePath: string;
}

interface SerializableEdge {
  sourceId: string; targetId: string; type: string;
}

function serializeGraph(graph: KnowledgeGraph): { nodes: SerializableNode[]; edges: SerializableEdge[] } {
  const nodes: SerializableNode[] = [];
  for (const node of graph.iterNodes()) {
    nodes.push({
      id: node.id,
      label: node.label,
      name: (node.properties.name as string) ?? node.id,
      filePath: (node.properties.filePath as string) ?? '',
    });
  }
  const edges: SerializableEdge[] = [];
  for (const rel of graph.iterRelationships()) {
    edges.push({ sourceId: rel.sourceId, targetId: rel.targetId, type: rel.type });
  }
  return { nodes, edges };
}

// ── HTML template ────────────────────────────────────────────────────────────

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

function graphHtml(webview: vscode.Webview, data: { nodes: SerializableNode[]; edges: SerializableEdge[] }): string {
  const nonce = getNonce();
  const json = JSON.stringify(data);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1e1e1e; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    svg { width: 100vw; height: 100vh; }
    .node circle { stroke: #1e1e1e; stroke-width: 1.5; cursor: pointer; transition: r 0.2s; }
    .node text { fill: #d4d4d4; font-size: 10px; pointer-events: none; }
    .edge line { stroke: #444; stroke-width: 0.5; }
    .edge text { fill: #666; font-size: 7px; }
    .legend { position: fixed; top: 10px; left: 10px; background: #2d2d2d; padding: 8px 12px; border-radius: 6px; font-size: 11px; color: #d4d4d4; display: flex; flex-wrap: wrap; gap: 6px; max-width: 360px; }
    .legend-item { display: flex; align-items: center; gap: 4px; }
    .legend-swatch { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  </style>
</head>
<body>
  <div class="legend" id="legend"></div>
  <svg id="graph-svg"></svg>
  <script nonce="${nonce}">
    (function() {
      var data = ${json};
      var svg = document.getElementById('graph-svg');
      var legend = document.getElementById('legend');
      var width = window.innerWidth;
      var height = window.innerHeight;

      // ── Force layout ──────────────────────────────────────────────────────
      var positions = {};
      var centerX = width / 2, centerY = height / 2;
      for (var i = 0; i < data.nodes.length; i++) {
        var n = data.nodes[i];
        positions[n.id] = { x: centerX + (Math.random() - 0.5) * 200, y: centerY + (Math.random() - 0.5) * 200, vx: 0, vy: 0 };
      }

      var edgeList = [];
      for (var e = 0; e < data.edges.length; e++) {
        var edge = data.edges[e];
        if (positions[edge.sourceId] && positions[edge.targetId]) {
          edgeList.push({ source: edge.sourceId, target: edge.targetId, type: edge.type });
        }
      }

      // #214: Cap nodes to top 1000 by degree to prevent O(N2) freeze
      var cappedInfo = '';
      var totalNodes = Object.keys(positions).length;
      if (edgeList.length > 0 && totalNodes > 1000) {
        var degree = {};
        for (var e = 0; e < edgeList.length; e++) {
          var ed = edgeList[e];
          degree[ed.source] = (degree[ed.source] || 0) + 1;
          degree[ed.target] = (degree[ed.target] || 0) + 1;
        }
        var topIds = Object.keys(positions).sort(function(a, b) { return (degree[b] || 0) - (degree[a] || 0); }).slice(0, 1000);
        var topSet = {};
        for (var t = 0; t < topIds.length; t++) topSet[topIds[t]] = true;
        edgeList = edgeList.filter(function(ed) { return topSet[ed.source] && topSet[ed.target]; });
        var newPositions = {};
        for (var t = 0; t < topIds.length; t++) { var tid = topIds[t]; newPositions[tid] = positions[tid]; }
        positions = newPositions;
        data.nodes = data.nodes.filter(function(n) { return topSet[n.id]; });
        cappedInfo = ' (showing top 1,000 of ' + totalNodes + ' nodes by connections)';
      }

      // #214: Adaptive iterations based on node count
      var nodeIds = Object.keys(positions);
      var iterations = nodeIds.length < 200 ? 80 : nodeIds.length < 600 ? 50 : 30;
      var repulsion = 8000, springLen = 120, springK = 0.02, damping = 0.9;
      for (var iter = 0; iter < iterations; iter++) {
        // Repulsion
        for (var i = 0; i < nodeIds.length; i++) {
          for (var j = i + 1; j < nodeIds.length; j++) {
            var a = positions[nodeIds[i]], b = positions[nodeIds[j]];
            var dx = a.x - b.x, dy = a.y - b.y;
            var dist = Math.sqrt(dx * dx + dy * dy) || 1;
            var force = repulsion / (dist * dist);
            var fx = (dx / dist) * force, fy = (dy / dist) * force;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
          }
        }
        // Spring (edges)
        for (var e = 0; e < edgeList.length; e++) {
          var src = positions[edgeList[e].source], tgt = positions[edgeList[e].target];
          var dx = tgt.x - src.x, dy = tgt.y - src.y;
          var dist = Math.sqrt(dx * dx + dy * dy) || 1;
          var force = (dist - springLen) * springK;
          var fx = (dx / dist) * force, fy = (dy / dist) * force;
          src.vx += fx; src.vy += fy;
          tgt.vx -= fx; tgt.vy -= fy;
        }
        // Center gravity
        for (var n = 0; n < nodeIds.length; n++) {
          var p = positions[nodeIds[n]];
          p.vx += (centerX - p.x) * 0.001;
          p.vy += (centerY - p.y) * 0.001;
        }
        // Apply velocity
        for (var n = 0; n < nodeIds.length; n++) {
          var p = positions[nodeIds[n]];
          p.x += p.vx * damping; p.y += p.vy * damping;
          p.vx *= damping; p.vy *= damping;
        }
      }

      // ── Render ────────────────────────────────────────────────────────────
      var colours = ${JSON.stringify({
        File: '#4a9eff', Folder: '#7eb8ff', Package: '#5c9ce6',
        Function: '#2ecc71', Method: '#27ae60', Class: '#9b59b6',
        Interface: '#8e44ad', Enum: '#a569bd', Variable: '#f39c12',
        Import: '#95a5a6', Type: '#1abc9c', Struct: '#16a085',
        Route: '#e74c3c', Tool: '#e67e22', Community: '#3498db',
        Process: '#2c3e50', Framework: '#c0392b',
      })};

      function colour(label) { return colours[label] || '#7f8c8d'; }

      var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      svg.appendChild(g);

      // #210: Store source/target IDs on edges for click-to-highlight
      // Edges
      for (var e = 0; e < edgeList.length; e++) {
        var edge = edgeList[e];
        var src = positions[edge.source], tgt = positions[edge.target];
        var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', src.x); line.setAttribute('y1', src.y);
        line.setAttribute('x2', tgt.x); line.setAttribute('y2', tgt.y);
        line.setAttribute('data-source', edge.source);
        line.setAttribute('data-target', edge.target);
        line.setAttribute('data-edge', edge.type);
        line.classList.add('edge');
        g.appendChild(line);
      }

      // Nodes
      var nodeEls = {};
      for (var n = 0; n < data.nodes.length; n++) {
        var node = data.nodes[n];
        var pos = positions[node.id];
        var group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.classList.add('node');
        group.setAttribute('data-id', node.id);
        group.setAttribute('data-label', node.label);

        var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', pos.x); circle.setAttribute('cy', pos.y);
        circle.setAttribute('r', node.label === 'File' ? 5 : 4);
        circle.setAttribute('fill', colour(node.label));
        group.appendChild(circle);

        if (node.name) {
          var text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          text.setAttribute('x', pos.x + 7); text.setAttribute('y', pos.y + 3);
          text.textContent = node.name.length > 25 ? node.name.slice(0, 25) + '...' : node.name;
          group.appendChild(text);
        }

        g.appendChild(group);
        nodeEls[node.id] = group;
      }

      // ── Legend ────────────────────────────────────────────────────────────
      var seenLabels = {};
      for (var n = 0; n < data.nodes.length; n++) {
        var label = data.nodes[n].label;
        if (seenLabels[label]) continue;
        seenLabels[label] = true;
        var item = document.createElement('div');
        item.className = 'legend-item';
        var swatch = document.createElement('div');
        swatch.className = 'legend-swatch';
        swatch.style.background = colour(label);
        item.appendChild(swatch);
        item.appendChild(document.createTextNode(label));
        legend.appendChild(item);
      }

      if (cappedInfo) {
        var capEl = document.createElement('div');
        capEl.style.cssText = 'flex-basis:100%;font-size:9px;color:#888;margin-top:2px;';
        capEl.textContent = cappedInfo;
        legend.appendChild(capEl);
      }

      // ── Interaction ───────────────────────────────────────────────────────
      var viewBox = { x: 0, y: 0, w: width, h: height };
      var dragging = false, lastX = 0, lastY = 0;
      var highlighted = null;

      function updateView() {
        svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
      }

      svg.addEventListener('wheel', function(e) {
        e.preventDefault();
        var scale = e.deltaY < 0 ? 0.9 : 1.1;
        var mx = e.offsetX, my = e.offsetY;
        var dx = mx * (scale - 1);
        var dy = my * (scale - 1);
        viewBox.x += dx; viewBox.y += dy;
        viewBox.w *= scale; viewBox.h *= scale;
        updateView();
      });

      svg.addEventListener('mousedown', function(e) {
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        svg.style.cursor = 'grabbing';
      });

      svg.addEventListener('mousemove', function(e) {
        if (!dragging) return;
        var dx = (e.clientX - lastX) * (viewBox.w / width);
        var dy = (e.clientY - lastY) * (viewBox.h / height);
        viewBox.x -= dx; viewBox.y -= dy;
        lastX = e.clientX; lastY = e.clientY;
        updateView();
      });

      svg.addEventListener('mouseup', function() { dragging = false; svg.style.cursor = 'default'; });

      // #210: Click node to highlight — uses data-source/data-target, not coordinate hacks
      g.addEventListener('click', function(e) {
        var el = e.target.closest('.node');
        if (!el) {
          // Deselect
          if (highlighted) {
            for (var i = 0; i < g.children.length; i++) {
              g.children[i].style.opacity = '1';
            }
            highlighted = null;
          }
          return;
        }
        var id = el.getAttribute('data-id');
        highlighted = id;
        for (var i = 0; i < g.children.length; i++) {
          var child = g.children[i];
          if (child.tagName === 'line') {
            var srcId = child.getAttribute('data-source');
            var tgtId = child.getAttribute('data-target');
            child.style.opacity = (srcId === id || tgtId === id) ? '0.8' : '0.05';
          } else {
            child.style.opacity = child.getAttribute('data-id') === id ? '1' : '0.15';
          }
        }
      });

      window.addEventListener('resize', function() {
        width = window.innerWidth; height = window.innerHeight;
      });

      updateView();
    })();
  </script>
</body>
</html>`;
}

// ── Panel provider ───────────────────────────────────────────────────────────

export function showGraphPanel(_context: vscode.ExtensionContext, dbPath: string): void {
  const store = createSqliteStore(dbPath);
  let graph: KnowledgeGraph;
  try {
    graph = store.loadGraph();
  } finally { store.close(); }

  const panel = vscode.window.createWebviewPanel(
    'astrolabeGraph',
    'Astrolabe Knowledge Graph',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  panel.webview.html = graphHtml(panel.webview, serializeGraph(graph));
}
