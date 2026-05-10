// ---------------------------------------------------------------------------
// Astrolabe Web UI — D3 force-directed graph visualization component
// Adapted from packages/vscode/webview/src/main.ts D3 patterns
// ---------------------------------------------------------------------------

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import type { GraphNode, GraphEdge } from './types';

// ── Types ──────────────────────────────────────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  name: string;
  filePath?: string;
  startLine?: number;
  width: number;
  height: number;
}

type SimLink = d3.SimulationLinkDatum<SimNode> & {
  type: string;
  confidence?: number;
};

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeSelect?: (node: GraphNode) => void;
}

// ── Constants ──────────────────────────────────────────────────────────────

const TEXT_MAX = 22;
const RECT_W_MIN = 90;
const RECT_W_MAX = 220;
const RECT_H = 38;
const RECT_RX = 5;
const MAX_DEPTH = 3;

// ── 17 categorical colours mapped by label type ────────────────────────────

const LABEL_COLORS: Record<string, string> = {
  File: '#4a9eff',
  Function: '#2ecc71',
  Class: '#9b59b6',
  Method: '#e67e22',
  Variable: '#e74c3c',
  Route: '#1abc9c',
  Import: '#f39c12',
  Module: '#3498db',
  Parameter: '#95a5a6',
  Interface: '#8e44ad',
  Property: '#f1c40f',
  Enum: '#c0392b',
  Type: '#16a085',
  Decorator: '#7f8c8d',
  Template: '#d35400',
  Middleware: '#2980b9',
  Config: '#27ae60',
};

function nodeColour(label: string): string {
  return LABEL_COLORS[label] ?? '#7f8c8d';
}

function textColourForLabel(label: string): string {
  const hex = nodeColour(label);
  // Parse hex directly to avoid D3 type union issues
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '#ffffff';
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  // WCAG relative luminance
  const l = 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
  return l > 0.55 ? '#b0b0b0' : '#ffffff';
}

function measureTextWidth(name: string): number {
  return Math.min(RECT_W_MAX, Math.max(RECT_W_MIN, name.length * 7.5 + 24));
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\u2026' : text;
}

// ── BFS neighbour expansion ────────────────────────────────────────────────

function neighboursOf(id: string, links: SimLink[]): Set<string> {
  const s = new Set<string>();
  for (const l of links) {
    if ((l.source as SimNode).id === id) s.add((l.target as SimNode).id);
    if ((l.target as SimNode).id === id) s.add((l.source as SimNode).id);
  }
  return s;
}

function expandToDepth(focus: string, depth: number, links: SimLink[]): Set<string> {
  let frontier = new Set<string>([focus]);
  const visited = new Set<string>([focus]);
  for (let i = 1; i <= depth; i++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const n of neighboursOf(id, links)) {
        if (!visited.has(n)) {
          next.add(n);
          visited.add(n);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

// ── Component ──────────────────────────────────────────────────────────────

export function GraphCanvas({
  nodes,
  edges,
  onNodeSelect,
}: GraphCanvasProps) {
  // ── Ref-based state ──────────────────────────────────────────────────
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  // Refs for mutable values accessed inside D3 event handlers
  const focusIdRef = useRef<string | null>(null);
  const depthRef = useRef<number>(1);
  const simNodesRef = useRef<SimNode[]>([]);
  const simLinksRef = useRef<SimLink[]>([]);
  const nodeMapRef = useRef<Map<string, GraphNode>>(new Map());

  // React state (drives re-renders of overlays / sidebar)
  const [focusId, setFocusId] = useState<string | null>(null);
  const [depth, setDepth] = useState<number>(1);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  // ── Derived: unique labels for legend ────────────────────────────────
  const legendLabels = useMemo(() => {
    return [...new Set(nodes.map((n) => n.label))].sort();
  }, [nodes]);

  // ── Sync refs when focus/depth change from UI ────────────────────────
  const selectNode = useCallback(
    (nodeId: string | null, newDepth?: number) => {
      focusIdRef.current = nodeId;
      depthRef.current = newDepth ?? 1;
      setFocusId(nodeId);
      setDepth(newDepth ?? 1);
      const found = nodeId ? nodeMapRef.current.get(nodeId) ?? null : null;
      setSelectedNode(found);
      if (found && onNodeSelect) onNodeSelect(found);
    },
    [onNodeSelect],
  );

  // ── Apply opacity after focus/depth changes ──────────────────────────
  const applyOpacity = useCallback(() => {
    const g = d3.select('#astrolabe-graph-g');
    if (g.empty()) return;

    const fId = focusIdRef.current;
    const d = depthRef.current;
    const links = simLinksRef.current;

    if (!fId) {
      g.selectAll<SVGGElement, SimNode>('.astrolabe-node').style('opacity', '1');
      g.selectAll<SVGLineElement, SimLink>('.astrolabe-link').style('opacity', '0.4');
      return;
    }

    const visible = expandToDepth(fId, d, links);
    g.selectAll<SVGGElement, SimNode>('.astrolabe-node').style(
      'opacity',
      (node: SimNode) => (visible.has(node.id) ? '1' : '0.12'),
    );
    g.selectAll<SVGLineElement, SimLink>('.astrolabe-link').style(
      'opacity',
      (link: SimLink) => {
        const src = visible.has((link.source as SimNode).id);
        const tgt = visible.has((link.target as SimNode).id);
        return src && tgt ? '0.7' : '0.03';
      },
    );
  }, []);

  // ── Re-apply opacity when focusId or depth change ────────────────────
  useEffect(() => {
    applyOpacity();
  }, [focusId, depth, applyOpacity]);

  // ── Main D3 lifecycle ────────────────────────────────────────────────
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    // Stop previous simulation and clean up
    if (simRef.current) simRef.current.stop();
    d3.select(svgEl).on('.zoom', null);
    d3.select(svgEl).selectAll('*').remove();

    // ── Empty state ────────────────────────────────────────────────────
    if (!nodes.length) {
      resetSelection();
      return;
    }

    // ── Dimensions ─────────────────────────────────────────────────────
    const container = containerRef.current;
    const W = (container?.clientWidth ?? svgEl.clientWidth) || 800;
    const H = (container?.clientHeight ?? svgEl.clientHeight) || 600;

    const svg = d3.select(svgEl);

    // ── Arrowhead marker ───────────────────────────────────────────────
    svg
      .append('defs')
      .append('marker')
      .attr('id', 'astrolabe-arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 18)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#555');

    // ── Zoom group ─────────────────────────────────────────────────────
    const g = svg.append('g').attr('id', 'astrolabe-graph-g');

    // ── Build node map and simulation data ─────────────────────────────
    const nodeMap = new Map<string, GraphNode>();
    for (const n of nodes) nodeMap.set(n.id, n);
    nodeMapRef.current = nodeMap;

    const simNodes: SimNode[] = nodes.map((n) => ({
      id: n.id,
      label: n.label,
      name: n.name,
      filePath: n.filePath,
      startLine: n.startLine,
      width: measureTextWidth(n.name),
      height: RECT_H,
      x: W / 2 + (Math.random() - 0.5) * 200,
      y: H / 2 + (Math.random() - 0.5) * 200,
    }));

    const simLinks: SimLink[] = [];
    for (const e of edges) {
      if (nodeMap.has(e.sourceId) && nodeMap.has(e.targetId)) {
        simLinks.push({
          source: e.sourceId,
          target: e.targetId,
          type: e.type,
          confidence: e.confidence,
        });
      }
    }

    simNodesRef.current = simNodes;
    simLinksRef.current = simLinks;

    // ── Links (data join: enter/update/exit) ───────────────────────────
    const linkG = g.append('g').attr('class', 'links');
    const link = linkG
      .selectAll<SVGLineElement, SimLink>('line')
      .data(simLinks, (_d: SimLink) => `${typeof _d.source === 'string' ? _d.source : (_d.source as SimNode).id}-${typeof _d.target === 'string' ? _d.target : (_d.target as SimNode).id}-${_d.type}`)
      .join('line')
      .attr('class', 'astrolabe-link')
      .attr('stroke', '#555')
      .attr('stroke-width', (_d: SimLink) => Math.max(0.5, (_d.confidence ?? 0.5) * 1.6))
      .attr('marker-end', 'url(#astrolabe-arrow)')
      .style('opacity', 0.4);

    link.exit().remove();

    // ── Nodes (data join: enter/update/exit) ───────────────────────────
    const nodeG = g.append('g').attr('class', 'nodes');
    const nodeSel = nodeG
      .selectAll<SVGGElement, SimNode>('g')
      .data(simNodes, (_d: SimNode) => _d.id)
      .join('g')
      .attr('class', 'astrolabe-node')
      .style('cursor', 'pointer');

    nodeSel.exit().remove();

    // ── Node: rectangle ────────────────────────────────────────────────
    nodeSel
      .selectAll<SVGRectElement, SimNode>('rect')
      .data((_d: SimNode) => [_d])
      .join('rect')
      .attr('width', (_d: SimNode) => _d.width)
      .attr('height', (_d: SimNode) => _d.height)
      .attr('rx', RECT_RX)
      .attr('ry', RECT_RX)
      .attr('fill', (_d: SimNode) => nodeColour(_d.label))
      .attr('stroke', (_d: SimNode) => d3.color(nodeColour(_d.label))!.darker(0.4).formatHex())
      .attr('stroke-width', 1)
      .style('opacity', 0.9);

    // ── Node: name text (bold 11px) ────────────────────────────────────
    nodeSel
      .selectAll<SVGTextElement, SimNode>('text.name-text')
      .data((_d: SimNode) => [_d])
      .join('text')
      .attr('class', 'name-text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', (_d: SimNode) => textColourForLabel(_d.label))
      .attr('font-size', '11px')
      .attr('font-weight', '600')
      .attr('font-family', 'sans-serif')
      .attr('x', (_d: SimNode) => _d.width / 2)
      .attr('y', (_d: SimNode) => _d.height / 2 - 5)
      .text((_d: SimNode) => truncate(_d.name, TEXT_MAX));

    // ── Node: label text (8px, 0.7 opacity) ────────────────────────────
    nodeSel
      .selectAll<SVGTextElement, SimNode>('text.label-text')
      .data((_d: SimNode) => [_d])
      .join('text')
      .attr('class', 'label-text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', (_d: SimNode) => textColourForLabel(_d.label))
      .attr('font-size', '8px')
      .attr('font-family', 'sans-serif')
      .style('opacity', 0.7)
      .attr('x', (_d: SimNode) => _d.width / 2)
      .attr('y', (_d: SimNode) => _d.height / 2 + 11)
      .text((_d: SimNode) => _d.label);

    // ── Hover effects ──────────────────────────────────────────────────
    nodeSel
      .on('mouseenter', function (this: SVGGElement) {
        d3.select(this)
          .select('rect')
          .style('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))');
      })
      .on('mouseleave', function (this: SVGGElement) {
        d3.select(this).select('rect').style('filter', null);
      });

    // ── Click: select / cycle depth ────────────────────────────────────
    nodeSel.on('click', (event: MouseEvent, d: SimNode) => {
      event.stopPropagation();
      if (focusIdRef.current === d.id) {
        // Cycle depth: 1 → 2 → 3 → 1
        const nextDepth = depthRef.current >= MAX_DEPTH ? 1 : depthRef.current + 1;
        depthRef.current = nextDepth;
        setDepth(nextDepth);
      } else {
        selectNode(d.id, depthRef.current);
      }
    });

    // ── Right-click: deselect / cycle depth backward ───────────────────
    nodeSel.on('contextmenu', (event: MouseEvent, d: SimNode) => {
      event.preventDefault();
      event.stopPropagation();
      if (focusIdRef.current === d.id) {
        const nextDepth = depthRef.current <= 1 ? MAX_DEPTH : depthRef.current - 1;
        depthRef.current = nextDepth;
        setDepth(nextDepth);
      }
    });

    // ── Click SVG background: deselect ─────────────────────────────────
    svg.on('click', () => {
      selectNode(null);
    });

    // ── Force simulation ───────────────────────────────────────────────
    const sim = d3
      .forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimLink>(simLinks)
          .id((_d: SimNode) => _d.id)
          .distance(140),
      )
      .force('charge', d3.forceManyBody().strength(-350))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force(
        'collide',
        d3.forceCollide<SimNode>((_d: SimNode) => Math.max(_d.width, _d.height) / 2 + 8),
      )
      .on('tick', () => {
        link
          .attr('x1', (_d: SimLink) => ((_d.source as SimNode).x ?? 0))
          .attr('y1', (_d: SimLink) => ((_d.source as SimNode).y ?? 0))
          .attr('x2', (_d: SimLink) => ((_d.target as SimNode).x ?? 0))
          .attr('y2', (_d: SimLink) => ((_d.target as SimNode).y ?? 0));
        nodeSel.attr(
          'transform',
          (_d: SimNode) => `translate(${(_d.x ?? 0) - _d.width / 2},${(_d.y ?? 0) - _d.height / 2})`,
        );
      });

    simRef.current = sim;

    // ── Zoom / pan ─────────────────────────────────────────────────────
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr('transform', event.transform.toString());
      });

    svg.call(zoom).on('dblclick.zoom', null);
    zoomRef.current = zoom;

    // ── Cleanup ────────────────────────────────────────────────────────
    return () => {
      sim.stop();
      d3.select(svgEl).on('.zoom', null);
    };
  }, [nodes, edges, onNodeSelect]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Helper to reset selection ────────────────────────────────────────
  function resetSelection() {
    selectNode(null);
  }

  // ── Incoming / outgoing edges for sidebar ────────────────────────────
  const incoming = useMemo(() => {
    if (!selectedNode) return [];
    return simLinksRef.current.filter(
      (_l: SimLink) => (_l.target as SimNode).id === selectedNode.id,
    );
  }, [selectedNode]);

  const outgoing = useMemo(() => {
    if (!selectedNode) return [];
    return simLinksRef.current.filter(
      (_l: SimLink) => (_l.source as SimNode).id === selectedNode.id,
    );
  }, [selectedNode]);

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
      }}
    >
      {/* ── Graph area ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        {/* Empty state */}
        {nodes.length === 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#8b949e',
              fontSize: '1.1rem',
              zIndex: 20,
              pointerEvents: 'none',
            }}
          >
            No graph data
          </div>
        )}

        {/* Legend overlay — top-left */}
        {legendLabels.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              zIndex: 10,
              display: 'flex',
              flexWrap: 'wrap',
              gap: '4px 10px',
              background: 'rgba(13, 17, 23, 0.88)',
              backdropFilter: 'blur(8px)',
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid rgba(48, 54, 61, 0.6)',
              maxWidth: 'calc(100% - 16px)',
            }}
          >
            {legendLabels.map((label) => (
              <div
                key={label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: '10px',
                  color: '#c9d1d9',
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: nodeColour(label),
                    flexShrink: 0,
                  }}
                />
                {label}
              </div>
            ))}
          </div>
        )}

        {/* Depth indicator overlay — top-right */}
        {focusId && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 10,
              background: 'rgba(13, 17, 23, 0.88)',
              backdropFilter: 'blur(8px)',
              padding: '4px 12px',
              borderRadius: 6,
              border: '1px solid rgba(48, 54, 61, 0.6)',
              fontSize: '11px',
              color: '#c9d1d9',
              lineHeight: '20px',
            }}
          >
            Depth: {depth}
            <span style={{ marginLeft: 8, color: '#8b949e' }}>
              ({expandToDepth(focusId, depth, simLinksRef.current).size} nodes)
            </span>
          </div>
        )}

        {/* SVG */}
        <svg
          ref={svgRef}
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            background: '#0d1117',
          }}
        />
      </div>

      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      {selectedNode && (
        <div
          style={{
            width: 280,
            flexShrink: 0,
            borderLeft: '1px solid #30363d',
            background: '#161b22',
            overflowY: 'auto',
            padding: '16px',
            boxSizing: 'border-box',
            color: '#c9d1d9',
            fontSize: '13px',
          }}
        >
          {/* Label badge */}
          <span
            style={{
              display: 'inline-block',
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: '11px',
              fontWeight: 600,
              background: nodeColour(selectedNode.label) + '33',
              color: nodeColour(selectedNode.label),
              marginBottom: 8,
            }}
          >
            {selectedNode.label}
          </span>

          {/* Name */}
          <div
            style={{
              fontSize: '15px',
              fontWeight: 600,
              marginBottom: 12,
              wordBreak: 'break-word',
              color: '#f0f6fc',
            }}
          >
            {selectedNode.name}
          </div>

          {/* ID */}
          <SidebarProperty label="ID" value={selectedNode.id} />

          {/* File path */}
          {selectedNode.filePath && (
            <SidebarProperty label="File" value={selectedNode.filePath} />
          )}

          {/* Start line */}
          {selectedNode.startLine !== undefined && (
            <SidebarProperty label="Line" value={String(selectedNode.startLine)} />
          )}

          {/* Edges section */}
          {(incoming.length > 0 || outgoing.length > 0) && (
            <>
              <div
                style={{
                  marginTop: 16,
                  marginBottom: 8,
                  paddingTop: 12,
                  borderTop: '1px solid #30363d',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#8b949e',
                }}
              >
                Edges ({incoming.length + outgoing.length})
              </div>

              {incoming.slice(0, 30).map((e, i) => (
                <div
                  key={`in-${i}`}
                  style={{
                    fontSize: '11px',
                    color: '#8b949e',
                    padding: '2px 0',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  ← {e.type} from{' '}
                  <span style={{ color: '#c9d1d9' }}>
                    {truncate((e.source as SimNode).name, 28)}
                  </span>
                </div>
              ))}

              {outgoing.slice(0, 30).map((e, i) => (
                <div
                  key={`out-${i}`}
                  style={{
                    fontSize: '11px',
                    color: '#8b949e',
                    padding: '2px 0',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  → {e.type} to{' '}
                  <span style={{ color: '#c9d1d9' }}>
                    {truncate((e.target as SimNode).name, 28)}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sidebar helper ─────────────────────────────────────────────────────────

function SidebarProperty({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 6, lineHeight: '18px' }}>
      <strong style={{ color: '#8b949e', fontWeight: 500, marginRight: 6 }}>
        {label}
      </strong>
      <span
        style={{
          color: '#c9d1d9',
          wordBreak: 'break-all',
          fontSize: '12px',
        }}
      >
        {escHtml(value)}
      </span>
    </div>
  );
}

// ── XSS safety ─────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
