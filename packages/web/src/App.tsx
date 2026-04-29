import { useState, useEffect, useCallback, useRef } from 'react';
import GraphView from './components/GraphView';
import SearchBar from './components/SearchBar';
import Sidebar from './components/Sidebar';
import type { RepoInfo, ClusterInfo, SearchResult, ApiRepos } from './types';

const API = '/api';

type ConnStatus = 'checking' | 'connected' | 'offline';

interface GraphNode {
  id: string; label: string; name: string; filePath: string; startLine: number;
}
interface GraphEdge {
  sourceId: string; targetId: string; type: string; confidence: number;
}
interface GraphData {
  nodes: GraphNode[]; edges: GraphEdge[]; nodeCount: number; edgeCount: number;
}

export default function App() {
  const [repos, setRepos] = useState<Array<{ name: string; path: string }>>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [clusters, setClusters] = useState<ClusterInfo[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connStatus, setConnStatus] = useState<ConnStatus>('checking');
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [selectedClusterId, setSelectedClusterId] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  // Bridge mode: auto-detect local server (#377)
  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((health: { status: string; repos?: Array<{ name: string; path: string }> }) => {
        setConnStatus('connected');
        if (health.repos && health.repos.length > 0) {
          setRepos(health.repos);
        }
      })
      .catch(() => {
        setConnStatus('offline');
        setError('Not connected to Astrolabe server. Run: astrolabe serve');
      });
  }, []);

  // Also try to fetch full repo list from dedicated endpoint
  useEffect(() => {
    if (connStatus !== 'connected') return;
    fetch(`${API}/repos`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: ApiRepos) => setRepos(data.repos || []))
      .catch(() => {}); // repos already set from health check if available
  }, [connStatus]);

  // Load graph for a specific cluster (#372)
  const selectCluster = useCallback(async (clusterId: string) => {
    if (!selectedRepo) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    setSelectedClusterId(clusterId);
    setLoading(true);

    try {
      const url = `${API}/repo/${encodeURIComponent(selectedRepo)}/graph?cluster=${encodeURIComponent(clusterId)}`;
      const res = await fetch(url, { signal });
      if (signal.aborted) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setGraphData(data);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError('Failed to load graph data');
    } finally {
      setLoading(false);
    }
  }, [selectedRepo]);

  // Load repo context and clusters
  const selectRepo = useCallback(async (name: string) => {
    abortRef.current?.abort(); // #345: cancel stale requests
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    setSelectedRepo(name);
    setLoading(true);
    setError('');

    try {
      const [ctxRes, clRes] = await Promise.all([
        fetch(`${API}/repo/${encodeURIComponent(name)}/context`, { signal }),
        fetch(`${API}/repo/${encodeURIComponent(name)}/clusters`, { signal }),
      ]);
      if (signal.aborted) return;
      // #344: check HTTP status before parsing
      if (!ctxRes.ok) throw new Error(`HTTP ${ctxRes.status}`);
      if (!clRes.ok) throw new Error(`HTTP ${clRes.status}`);
      const ctx = await ctxRes.json();
      const cl = await clRes.json();
      setRepoInfo(ctx);
      setClusters(cl.clusters || []);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError('Failed to load repo data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Search
  const search = useCallback(async (query: string) => {
    if (!selectedRepo) return;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const signal = controller.signal;

    setLoading(true);
    try {
      const res = await fetch(`${API}/repo/${encodeURIComponent(selectedRepo)}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 30 }),
        signal,
      });
      if (signal.aborted) return;
      // #344: check HTTP status
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
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
        {connStatus === 'checking' && <div style={{ padding: '0.5rem 1rem', color: '#d29922', background: '#2a2100', fontSize: '0.85rem' }}>Connecting to server...</div>}
        {connStatus === 'offline' && <div style={{ padding: '0.5rem 1rem', color: '#f85149', background: '#490202', fontSize: '0.85rem' }}>Offline — run: <code>astrolabe serve</code></div>}
        {connStatus === 'connected' && repos.length > 0 && <div style={{ padding: '0.25rem 1rem', color: '#3fb950', background: '#0d1b14', fontSize: '0.75rem' }}>Connected • {repos.length} repo{repos.length !== 1 ? 's' : ''} indexed</div>}
        {error && <div style={{ padding: '1rem', color: '#f85149', background: '#490202' }}>{error}</div>}
        {loading && <div style={{ padding: '1rem', color: '#58a6ff' }}>Loading...</div>}
        <GraphView
          repoName={selectedRepo}
          clusters={clusters}
          graphData={graphData}
          loading={loading}
        />
      </main>
    </div>
  );
}
