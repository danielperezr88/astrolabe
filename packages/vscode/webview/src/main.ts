import * as d3 from 'd3';

// ── Types ──────────────────────────────────────────────────────────────────

interface NodeData {
  id: string; label: string; name: string; filePath: string;
  startLine?: number; endLine?: number;
  [key: string]: unknown;
}

interface EdgeData { sourceId: string; targetId: string; type: string; }

interface SimNode extends d3.SimulationNodeDatum {
  id: string; label: string; name: string; filePath: string;
  width: number; height: number;
  props: NodeData;
}
type SimLink = d3.SimulationLinkDatum<SimNode> & { type: string };

// ── Colours ─────────────────────────────────────────────────────────────────

const COLOURS: Record<string, string> = {
  File: '#4a9eff', Folder: '#7eb8ff', Package: '#5c9ce6',
  Function: '#2ecc71', Method: '#27ae60', Class: '#9b59b6',
  Interface: '#8e44ad', Enum: '#a569bd', Variable: '#f39c12',
  Import: '#95a5a6', Type: '#1abc9c', Struct: '#16a085',
  Route: '#e74c3c', Tool: '#e67e22', Community: '#3498db',
  Process: '#2c3e50', Framework: '#c0392b',
};
function colour(label: string) { return COLOURS[label] ?? '#7f8c8d'; }
function textColour(label: string) { return ['Route', 'Process', 'Framework', 'Class', 'Interface'].includes(label) ? '#fff' : '#111'; }

const TEXT_MAX = 22;
const RECT_W_MIN = 90, RECT_W_MAX = 220, RECT_H = 38, RECT_RX = 5;

function measureText(name: string): number {
  return Math.min(RECT_W_MAX, Math.max(RECT_W_MIN, name.length * 7.5 + 24));
}

// ── State ───────────────────────────────────────────────────────────────────

let sim: d3.Simulation<SimNode, SimLink> | null = null;
let zoom: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
let focusId: string | null = null;
let depth = 1; // 1, 2, or 3
const MAX_DEPTH = 3;

// ── Sidebar update ──────────────────────────────────────────────────────────

// #228: Escape HTML in user-controlled values to prevent XSS
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function updateSidebar(node: NodeData | null, nodes: SimNode[], links: SimLink[]) {
  const sidebar = d3.select('#sidebar');
  sidebar.html('');
  if (!node) {
    sidebar.append('div').attr('class', 'placeholder').text('Click a node to inspect');
    return;
  }

  const c = colour(node.label);
  sidebar.append('span').attr('class', 'label-badge')
    .style('background', c + '33').style('color', c).text(node.label);
  sidebar.append('div').attr('class', 'name').text(node.name);
  sidebar.append('div').attr('class', 'prop')
    .html(`<strong>ID</strong> ${esc(node.id)}`);
  sidebar.append('div').attr('class', 'prop')
    .html(`<strong>File</strong> ${esc(node.filePath || '—')}`);
  if (node.startLine) {
    sidebar.append('div').attr('class', 'prop')
      .html(`<strong>Lines</strong> ${esc(String(node.startLine))}–${esc(String(node.endLine ?? node.startLine))}`);
  }

  // Extra properties
  const skip = new Set(['id', 'label', 'name', 'filePath', 'startLine', 'endLine', 'x', 'y', 'vx', 'vy', 'fx', 'fy', 'width', 'height', 'index']);
  const extras = Object.entries(node).filter(([k]) => !skip.has(k) && k !== 'props');
  if (extras.length > 0) {
    extras.forEach(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (val.length < 100) {
        sidebar.append('div').attr('class', 'prop').html(`<strong>${esc(k)}</strong> ${esc(val)}`);
      }
    });
  }

  // Edges
  const n = nodes.find(x => x.id === node.id);
  if (n) {
    const incoming = links.filter(l => (l.target as SimNode).id === node.id);
    const outgoing = links.filter(l => (l.source as SimNode).id === node.id);
    const hasAny = incoming.length > 0 || outgoing.length > 0;
    if (hasAny) {
      sidebar.append('div').attr('class', 'edges-title').text(`Edges (${incoming.length + outgoing.length})`);
      incoming.slice(0, 30).forEach(e => {
        const src = (e.source as SimNode).name;
        sidebar.append('div').attr('class', 'edge-row').text(`← ${e.type} from ${src}`);
      });
      outgoing.slice(0, 30).forEach(e => {
        const tgt = (e.target as SimNode).name;
        sidebar.append('div').attr('class', 'edge-row').text(`→ ${e.type} to ${tgt}`);
      });
    }
  }
}

// ── Legend ───────────────────────────────────────────────────────────────────

function buildLegend(labels: string[]) {
  const legend = d3.select('#legend');
  legend.html('');
  labels.forEach(l => {
    const item = legend.append('div').attr('class', 'legend-item');
    item.append('div').attr('class', 'legend-swatch').style('background', colour(l));
    item.append('span').text(l);
  });
}

// ── Neighbour expansion ─────────────────────────────────────────────────────

function neighboursOf(id: string, links: SimLink[]): Set<string> {
  const s = new Set<string>();
  links.forEach(l => {
    if ((l.source as SimNode).id === id) s.add((l.target as SimNode).id);
    if ((l.target as SimNode).id === id) s.add((l.source as SimNode).id);
  });
  return s;
}

function expandToDepth(focus: string, d: number, links: SimLink[]): Set<string> {
  let frontier = new Set<string>([focus]);
  const visited = new Set<string>([focus]);
  for (let i = 1; i <= d; i++) {
    const next = new Set<string>();
    frontier.forEach(id => {
      neighboursOf(id, links).forEach(n => { if (!visited.has(n)) { next.add(n); visited.add(n); } });
    });
    frontier = next;
  }
  return visited;
}

function applyOpacity(nodes: SimNode[], links: SimLink[]) {
  const g = d3.select('#graph-g');
  if (!focusId) {
    g.selectAll('.node').style('opacity', '1');
    g.selectAll('.link').style('opacity', '0.4');
    d3.select('#depth-ind').style('display', 'none');
    return;
  }
  const visible = expandToDepth(focusId, depth, links);
  g.selectAll('.node').style('opacity', (d: unknown) => visible.has((d as SimNode).id) ? '1' : '0.12');
  g.selectAll('.link').style('opacity', (d: unknown) => {
    const l = d as SimLink;
    const src = visible.has((l.source as SimNode).id);
    const tgt = visible.has((l.target as SimNode).id);
    return src && tgt ? '0.7' : '0.03';
  });
  d3.select('#depth-ind')
    .style('display', 'block')
    .text(`Depth: ${depth}`);
}

// ── Main render ─────────────────────────────────────────────────────────────

function render(data: { nodes: NodeData[]; edges: EdgeData[] }) {
  const svgEl = d3.select('#graph-svg');

  // #237: Stop previous simulation and remove stale zoom listeners before re-render
  if (sim) sim.stop();
  svgEl.on('.zoom', null);

  svgEl.selectAll('*').remove();
  const svg = svgEl as unknown as d3.Selection<SVGSVGElement, unknown, null, undefined>;
  const svgNode = svgEl.node() as SVGSVGElement;
  // #306: Fall back to explicit dimensions if SVG not laid out (panel hidden/minimized)
  const W = svgNode.clientWidth || 800;
  const H = svgNode.clientHeight || 600;

  // Arrow marker
  svg.append('defs').append('marker')
    .attr('id', 'arrowhead').attr('viewBox', '0 -5 10 10').attr('refX', 18).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#555');

  const g = svg.append('g').attr('id', 'graph-g');

  // Prepare nodes
  const nodeMap = new Map<string, NodeData>();
  data.nodes.forEach(n => nodeMap.set(n.id, n));
  const labels = [...new Set(data.nodes.map(n => n.label))].sort();
  buildLegend(labels);

  // Prepare sim data
  const simNodes: SimNode[] = data.nodes.map(n => ({
    id: n.id, label: n.label, name: n.name, filePath: n.filePath,
    width: measureText(n.name), height: RECT_H, props: n,
    x: W / 2 + (Math.random() - 0.5) * 200, y: H / 2 + (Math.random() - 0.5) * 200,
  }));
  const simLinks: SimLink[] = data.edges
    .filter(e => nodeMap.has(e.sourceId) && nodeMap.has(e.targetId))
    .map(e => ({ source: e.sourceId, target: e.targetId, type: e.type }));

  // Links
  const linkG = g.append('g').attr('class', 'links');
  const link = linkG.selectAll<SVGLineElement, SimLink>('line')
    .data(simLinks).join('line')
    .attr('class', 'link').attr('stroke', '#555').attr('stroke-width', 0.8)
    .attr('marker-end', 'url(#arrowhead)').style('opacity', 0.4);

  // Nodes
  const nodeG = g.append('g').attr('class', 'nodes');
  const node = nodeG.selectAll<SVGGElement, SimNode>('g')
    .data(simNodes).join('g').attr('class', 'node').style('cursor', 'pointer');

  // Rectangle
  node.append('rect')
    .attr('width', d => d.width).attr('height', d => d.height)
    .attr('rx', RECT_RX).attr('ry', RECT_RX)
    .attr('fill', d => colour(d.label)).attr('stroke', d => d3.color(colour(d.label))!.darker(0.4).formatHex())
    .attr('stroke-width', 1).style('opacity', 0.9);

  // Name text
  node.append('text')
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('fill', d => textColour(d.label)).attr('font-size', '11px').attr('font-weight', '600')
    .attr('x', d => d.width / 2).attr('y', d => d.height / 2 - 5)
    .text(d => d.name.length > TEXT_MAX ? d.name.slice(0, TEXT_MAX) + '…' : d.name);

  // Label text
  node.append('text')
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('fill', d => textColour(d.label)).attr('font-size', '8px')
    .style('opacity', 0.7).attr('x', d => d.width / 2).attr('y', d => d.height / 2 + 11)
    .text(d => d.label);

  // Hover shadow
  node.on('mouseenter', function() {
    d3.select(this).select('rect').style('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))');
  }).on('mouseleave', function() {
    d3.select(this).select('rect').style('filter', null);
  });

  // ── Click handler ──────────────────────────────────────────────────────
  node.on('click', (event: MouseEvent, d: SimNode) => {
    event.stopPropagation();
    if (focusId === d.id) {
      // Cycle depth forward
      depth = depth >= MAX_DEPTH ? 1 : depth + 1;
    } else {
      focusId = d.id;
      depth = 1;
    }
    applyOpacity(simNodes, simLinks);
    updateSidebar(focusId ? nodeMap.get(focusId) ?? null : null, simNodes, simLinks);
  });
  node.on('contextmenu', (event: MouseEvent, d: SimNode) => {
    event.preventDefault();
    event.stopPropagation();
    if (focusId === d.id) {
      depth = depth <= 1 ? MAX_DEPTH : depth - 1;
      applyOpacity(simNodes, simLinks);
      updateSidebar(focusId ? nodeMap.get(focusId) ?? null : null, simNodes, simLinks);
    }
  });

  // ── Click empty to deselect ────────────────────────────────────────────
  svg.on('click', () => {
    focusId = null;
    depth = 1;
    applyOpacity(simNodes, simLinks);
    updateSidebar(null, simNodes, simLinks);
  });

  // ── Force simulation ───────────────────────────────────────────────────
  sim = d3.forceSimulation<SimNode>(simNodes)
    .force('link', d3.forceLink<SimNode, SimLink>(simLinks)
      .id(d => d.id).distance(140))
    .force('charge', d3.forceManyBody().strength(-350))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collide', d3.forceCollide<SimNode>(d => Math.max(d.width, d.height) / 2 + 8))
    .on('tick', () => {
      link.attr('x1', d => (d.source as SimNode).x!)
        .attr('y1', d => (d.source as SimNode).y!)
        .attr('x2', d => (d.target as SimNode).x!)
        .attr('y2', d => (d.target as SimNode).y!);
      node.attr('transform', d => `translate(${d.x! - d.width / 2},${d.y! - d.height / 2})`);
    });

  // ── Zoom centered on pointer ───────────────────────────────────────────
  zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.1, 4])
    .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
      g.attr('transform', event.transform.toString());
    });
  svg.call(zoom).on('dblclick.zoom', null);
}

// ── Entry ───────────────────────────────────────────────────────────────────

declare global { interface Window { graphData: { nodes: NodeData[]; edges: EdgeData[] } | null; } }

function init() {
  // #307: Named function so we can remove the listener instead of stacking new ones
  function onMessage(e: MessageEvent) {
    // Only accept messages from the extension host (no origin in VSCode webviews)
    if (e.origin !== '') return;
    if (e.data?.type === 'graphData') {
      window.graphData = e.data.data;
      render(window.graphData!);
    }
  }
  window.removeEventListener('message', onMessage);
  window.addEventListener('message', onMessage);

  if (window.graphData) render(window.graphData);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
