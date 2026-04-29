import { useEffect, useRef } from 'react';
import type { ClusterInfo } from '../types';

interface Props {
  repoName: string;
  clusters: ClusterInfo[];
}

export default function GraphView({ repoName, clusters }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!clusters.length) return;
    // For MVP, render basic SVG-based cluster visualization
    // Sigma.js integration requires npm install — placeholder for now
  }, [clusters, repoName]);

  if (!clusters.length) {
    return (
      <div style={{ 
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: '#484f58', fontSize: '1.2rem'
      }}>
        {repoName ? 'No clusters detected' : 'Select a repository to view the graph'}
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: 'calc(100% - 52px)', padding: '1rem' }}>
      <svg width="100%" height="100%" viewBox="0 0 800 600" style={{ background: '#161b22', borderRadius: '8px' }}>
        {clusters.map((c, i) => {
          const cx = 100 + (i % 5) * 150;
          const cy = 100 + Math.floor(i / 5) * 150;
          const r = Math.min(60, 20 + c.symbolCount * 2);
          const hue = (i * 137) % 360;
          return (
            <g key={c.id}>
              <circle cx={cx} cy={cy} r={r} fill={`hsl(${hue}, 60%, 30%)`} stroke={`hsl(${hue}, 60%, 50%)`} strokeWidth="2" />
              <text x={cx} y={cy - 5} textAnchor="middle" fill="#c9d1d9" fontSize="11">{c.name}</text>
              <text x={cx} y={cy + 12} textAnchor="middle" fill="#8b949e" fontSize="10">{c.symbolCount} symbols</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
