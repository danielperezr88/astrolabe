import type { RepoInfo, ClusterInfo, SearchResult } from '../types';

interface Props {
  repos: Array<{ name: string; path: string }>;
  selectedRepo: string;
  onSelectRepo: (name: string) => void;
  repoInfo: RepoInfo | null;
  clusters: ClusterInfo[];
  searchResults: SearchResult[];
  onSearch: (query: string) => void;
  selectedClusterId: string;
  onSelectCluster: (clusterId: string) => void;
}

export default function Sidebar({ repos, selectedRepo, onSelectRepo, repoInfo, clusters, searchResults, selectedClusterId, onSelectCluster }: Props) {
  return (
    <nav style={{
      width: '320px', minWidth: '320px', background: '#161b22',
      borderRight: '1px solid #21262d', overflow: 'auto', padding: '1rem'
    }}>
      <h1 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '1rem', color: '#58a6ff' }}>
        Astrolabe
      </h1>

      {/* Repo selector */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '0.8rem', color: '#8b949e', marginBottom: '0.5rem', textTransform: 'uppercase' }}>
          Repositories
        </h2>
        {repos.length === 0 && <p style={{ color: '#484f58', fontSize: '0.85rem' }}>No repos indexed</p>}
        {repos.map((r) => (
          <button
            key={r.name}
            onClick={() => onSelectRepo(r.name)}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '0.4rem 0.5rem',
              background: selectedRepo === r.name ? '#1f6feb22' : 'transparent',
              border: '1px solid ' + (selectedRepo === r.name ? '#1f6feb' : 'transparent'),
              borderRadius: '4px', color: selectedRepo === r.name ? '#58a6ff' : '#c9d1d9',
              cursor: 'pointer', fontSize: '0.85rem', marginBottom: '0.25rem'
            }}
          >
            {r.name}
          </button>
        ))}
      </section>

      {/* Repo info */}
      {repoInfo && (
        <section style={{ marginBottom: '1.5rem', padding: '0.75rem', background: '#0d1117', borderRadius: '6px' }}>
          <h2 style={{ fontSize: '0.8rem', color: '#8b949e', marginBottom: '0.5rem', textTransform: 'uppercase' }}>
            Stats
          </h2>
          <div style={{ fontSize: '0.8rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem' }}>
            <span style={{ color: '#8b949e' }}>Symbols:</span><span>{repoInfo.nodes.toLocaleString()}</span>
            <span style={{ color: '#8b949e' }}>Edges:</span><span>{repoInfo.relationships.toLocaleString()}</span>
            <span style={{ color: '#8b949e' }}>Clusters:</span><span>{clusters.length}</span>
          </div>
          {repoInfo.metaStale && (
            <div style={{ marginTop: '0.5rem', padding: '0.3rem 0.5rem', background: '#f0883e22', borderRadius: '4px', color: '#f0883e', fontSize: '0.75rem' }}>
              ⚠ Index is stale
            </div>
          )}
        </section>
      )}

      {/* Clusters */}
      {clusters.length > 0 && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '0.8rem', color: '#8b949e', marginBottom: '0.5rem', textTransform: 'uppercase' }}>
            Communities ({clusters.length})
          </h2>
          {clusters.slice(0, 10).map((c) => (
            <button
              key={c.id}
              onClick={() => onSelectCluster(c.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '0.4rem 0.5rem', marginBottom: '0.25rem',
                background: selectedClusterId === c.id ? '#1f6feb22' : '#0d1117',
                border: '1px solid ' + (selectedClusterId === c.id ? '#1f6feb' : 'transparent'),
                borderRadius: '4px', color: '#c9d1d9', cursor: 'pointer', fontSize: '0.8rem'
              }}
            >
              <div style={{ fontWeight: 600 }}>{c.name}</div>
              <div style={{ color: '#8b949e' }}>{c.symbolCount} symbols · cohesion: {(c.cohesion ?? 0).toFixed(2)}</div>
            </button>
          ))}
        </section>
      )}

      {/* Search results */}
      {searchResults.length > 0 && (
        <section>
          <h2 style={{ fontSize: '0.8rem', color: '#8b949e', marginBottom: '0.5rem', textTransform: 'uppercase' }}>
            Results ({searchResults.length})
          </h2>
          {searchResults.slice(0, 15).map((r, i) => (
            <div key={i} style={{
              padding: '0.4rem 0.5rem', marginBottom: '0.25rem',
              background: '#0d1117', borderRadius: '4px', fontSize: '0.8rem'
            }}>
              <div>
                <span style={{
                  display: 'inline-block', padding: '0.1rem 0.3rem',
                  background: '#1f6feb22', color: '#58a6ff', borderRadius: '3px',
                  fontSize: '0.7rem', marginRight: '0.3rem'
                }}>{r.label}</span>
                <span style={{ fontWeight: 600 }}>{r.name}</span>
              </div>
              <div style={{ color: '#484f58', fontSize: '0.7rem', marginTop: '0.15rem' }}>{r.filePath}</div>
            </div>
          ))}
        </section>
      )}
    </nav>
  );
}
