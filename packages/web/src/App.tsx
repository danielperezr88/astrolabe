import { useState, useEffect, useCallback } from 'react';
import GraphView from './components/GraphView';
import SearchBar from './components/SearchBar';
import Sidebar from './components/Sidebar';
import type { RepoInfo, ClusterInfo, SearchResult, ApiRepos } from './types';

const API = '/api';

export default function App() {
  const [repos, setRepos] = useState<Array<{ name: string; path: string }>>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [clusters, setClusters] = useState<ClusterInfo[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Fetch available repos
  useEffect(() => {
    fetch(`${API}/repos`)
      .then((r) => r.json())
      .then((data: ApiRepos) => setRepos(data.repos || []))
      .catch(() => setError('Cannot reach Astrolabe server. Run: astrolabe serve'));
  }, []);

  // Load repo context and clusters
  const selectRepo = useCallback(async (name: string) => {
    setSelectedRepo(name);
    setLoading(true);
    setError('');

    try {
      const [ctxRes, clRes] = await Promise.all([
        fetch(`${API}/repo/${encodeURIComponent(name)}/context`),
        fetch(`${API}/repo/${encodeURIComponent(name)}/clusters`),
      ]);
      const ctx = await ctxRes.json();
      const cl = await clRes.json();
      setRepoInfo(ctx);
      setClusters(cl.clusters || []);
    } catch {
      setError('Failed to load repo data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Search
  const search = useCallback(async (query: string) => {
    if (!selectedRepo) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/repo/${encodeURIComponent(selectedRepo)}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 30 }),
      });
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch {
      setError('Search failed');
    } finally {
      setLoading(false);
    }
  }, [selectedRepo]);

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <Sidebar
        repos={repos}
        selectedRepo={selectedRepo}
        onSelectRepo={selectRepo}
        repoInfo={repoInfo}
        clusters={clusters}
        searchResults={searchResults}
        onSearch={search}
      />
      <main style={{ flex: 1, position: 'relative' }}>
        <SearchBar onSearch={search} disabled={!selectedRepo} />
        {error && <div style={{ padding: '1rem', color: '#f85149', background: '#490202' }}>{error}</div>}
        {loading && <div style={{ padding: '1rem', color: '#58a6ff' }}>Loading...</div>}
        <GraphView repoName={selectedRepo} clusters={clusters} />
      </main>
    </div>
  );
}
