import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { ClusterInfo } from '../types';

interface GraphNode {
  id: string;
  label: string;
  name: string;
  filePath: string;
  startLine: number;
}

interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: string;
  confidence: number;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeCount: number;
  edgeCount: number;
}

interface Props {
  repoName: string;
  clusters: ClusterInfo[];
  graphData: GraphData | null;
  loading?: boolean;
}

// ── Color by node label ────────────────────────────────────────────────────

const LABEL_COLORS: Record<string, string> = {
  Function: '#58a6ff',
  Method: '#58a6ff',
  Class: '#3fb950',
  Interface: '#3fb950',
  Process: '#d29922',
  Community: '#bc8cff',
  Route: '#f85149',
  Tool: '#f85149',
};

function nodeColor(label: string): string {
  return LABEL_COLORS[label] ?? '#8b949e';
}

// ── Tooltip ─────────────────────────────────────────────────────────────────

function showTooltip(
  event: MouseEvent,
  node: d3.SimulationNodeDatum & GraphNode,
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
) {
  d3.select('#graph-tooltip').remove();
  const tooltip = svg.append('g').attr('id', 'graph-tooltip');
  const box = tooltip.append('rect').attr('rx', 4).attr('fill', '#21262d').attr('stroke', '#30363d');
  const lines = [`${node.label}: ${node.name}`, node.filePath];
  const textHeight = 16;
  const padX = 8;
  const padY = 4;
  const maxWidth = Math.max(...lines.map((l) => l.length)) * 7 + padX * 2;

  lines.forEach((line, i) => {
    tooltip
      .append('text')
      .attr('x', padX)
      .attr('y', padY + (i + 1) * textHeight - 4)
      .attr('fill', i === 0 ? '#f0f6fc' : '#8b949e')
      .attr('font-size', i === 0 ? '12px' : '10px')
      .text(line);
  });

  box
    .attr('width', maxWidth)
    .attr('height', lines.length * textHeight + padY);

  tooltip.attr('transform', `translate(${node.x! + 12}, ${node.y! - 20})`);
}

// ── Component ──────────────────────────────────────────────────────────────

export default function GraphView({ repoName, clusters, graphData, loading }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    if (!graphData || !graphData.nodes.length || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const width = svgRef.current.clientWidth || 800;
    const height = svgRef.current.clientHeight || 600;

    // Build lookup maps
    const nodeMap = new Map(graphData.nodes.map((n) => ({ ...n } as any)).map((n) => [n.id, n]));
    const links: Array<{ source: string; target: string; type: string; confidence: number }> = [];

    for (const e of graphData.edges) {
      if (nodeMap.has(e.sourceId) && nodeMap.has(e.targetId)) {
        links.push({ source: e.sourceId, target: e.targetId, type: e.type, confidence: e.confidence });
      }
    }

    const simNodes: Array<d3.SimulationNodeDatum & GraphNode> = graphData.nodes.map((n) => ({
      ...n,
      x: width / 2 + (Math.random() - 0.5) * 200,
      y: height / 2 + (Math.random() - 0.5) * 200,
    }));

    const sim = d3
      .forceSimulation(simNodes)
      .force(
        'link',
        d3
          .forceLink(links)
          .id((d: any) => d.id)
          .distance(80),
      )
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide(30));

    // Edges
    const linkGroup = svg.append('g').attr('class', 'links');
    const link = linkGroup
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', '#30363d')
      .attr('stroke-width', (d) => Math.max(0.5, d.confidence * 2))
      .attr('stroke-opacity', 0.5);

    // Nodes
    const nodeGroup = svg.append('g').attr('class', 'nodes');
    const node = nodeGroup
      .selectAll('circle')
      .data(simNodes)
      .join('circle')
      .attr('r', (d) => (d.label === 'Community' ? 12 : d.label === 'Process' ? 8 : 5))
      .attr('fill', (d) => nodeColor(d.label))
      .attr('stroke', '#161b22')
      .attr('stroke-width', 1.5)
      .style('cursor', 'pointer');

    // Labels for larger nodes
    const labelGroup = svg.append('g').attr('class', 'labels');
    labelGroup
      .selectAll('text')
      .data(simNodes.filter((d) => d.label === 'Community' || d.label === 'Process'))
      .join('text')
      .attr('font-size', '9px')
      .attr('fill', '#c9d1d9')
      .attr('text-anchor', 'middle')
      .attr('dy', -14)
      .text((d) => d.name.length > 20 ? d.name.slice(0, 18) + '...' : d.name);

    // Interaction
    node
      .on('mouseenter', function (event, d) {
        setHovered(d.id);
        d3.select(this).attr('stroke', '#f0f6fc').attr('stroke-width', 2);
        showTooltip(event, d, svg);
      })
      .on('mouseleave', function () {
        setHovered(null);
        d3.select(this).attr('stroke', '#161b22').attr('stroke-width', 1.5);
        d3.select('#graph-tooltip').remove();
      })
      .on('click', (_, d) => {
        setHovered(d.id);
      });

    // Highlight connected edges on hover
    node.on('mouseenter.glow', function (_, d) {
      link.attr('stroke-opacity', (l: any) =>
        l.source.id === d.id || l.target.id === d.id ? 0.9 : 0.1,
      );
      node.attr('opacity', (n: any) =>
        n.id === d.id || links.some((l: any) =>
          (l.source.id === d.id && l.target.id === n.id) ||
          (l.target.id === d.id && l.source.id === n.id)
        ) ? 1 : 0.3,
      );
    });

    node.on('mouseleave.glow', function () {
      link.attr('stroke-opacity', 0.5);
      node.attr('opacity', 1);
    });

    // Simulation tick
    sim.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);
      node.attr('cx', (d: any) => d.x).attr('cy', (d: any) => d.y);
      labelGroup.selectAll('text').attr('x', (d: any) => d.x).attr('y', (d: any) => d.y);
    });

    // Drag
    const drag = d3
      .drag<SVGCircleElement, any>()
      .on('start', (event, d: any) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d: any) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d: any) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      }) as any;
    node.call(drag);

    return () => {
      sim.stop();
    };
  }, [graphData]);

  if (!graphData && !loading && !clusters.length) {
    return (
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100%', color: '#484f58', fontSize: '1.1rem',
        }}
      >
        {repoName ? 'Select a cluster to view graph' : 'Select a repository'}
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: '#58a6ff',
      }}>
        Loading graph...
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {graphData && (
        <div style={{
          position: 'absolute', top: 8, left: 8, zIndex: 10,
          background: '#0d1117cc', padding: '4px 10px', borderRadius: 4,
          fontSize: '11px', color: '#8b949e',
        }}>
          {graphData.nodeCount} nodes · {graphData.edgeCount} edges
        </div>
      )}
      <svg
        ref={svgRef}
        style={{ width: '100%', height: '100%', background: '#0d1117' }}
      />
    </div>
  );
}
