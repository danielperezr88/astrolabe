import { useEffect, useState, useCallback } from 'react';
import { RepoSidebar } from './RepoSidebar';
import { GraphCanvas } from './GraphCanvas';
import { ChatPanel } from './ChatPanel';
import { SearchPanel } from './SearchPanel';
import type { RepoInfo, GraphNode, GraphEdge } from './types';
import {
  fetchHealth,
  fetchGraph,
  fetchChat,
  startAnalysis,
  pollJob,
} from './api';

export function App() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<
    { phase: string; percent: number; message: string } | undefined
  >();
  const [chatVisible, setChatVisible] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);

  const loadRepos = useCallback(async () => {
    try {
      const data = await fetchHealth();
      setRepos(data.repos ?? []);
    } catch {
      // API server may not be available yet
    }
  }, []);

  const loadGraph = useCallback(async (repoName: string) => {
    try {
      const data = await fetchGraph(repoName);
      setNodes(data.nodes);
      setEdges(data.edges);
    } catch {
      setNodes([]);
      setEdges([]);
    }
  }, []);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  useEffect(() => {
    if (selectedRepo) {
      loadGraph(selectedRepo);
    } else {
      setNodes([]);
      setEdges([]);
    }
  }, [selectedRepo, loadGraph]);

  const handleSelectRepo = useCallback(
    (name: string) => {
      setSelectedRepo(name);
      setSearchVisible(false);
    },
    [],
  );

  const handleAnalyze = useCallback(
    async (path: string) => {
      setIsAnalyzing(true);
      setAnalyzeProgress({ phase: 'starting', percent: 0, message: 'Starting analysis...' });
      try {
        const { jobId } = await startAnalysis(path);
        const poll = setInterval(async () => {
          try {
            const job = await pollJob(jobId);
            setAnalyzeProgress({
              phase: job.status,
              percent: job.progress ?? 0,
              message: job.error ?? `${job.status}...`,
            });
            if (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') {
              clearInterval(poll);
              setIsAnalyzing(false);
              if (job.status === 'complete') {
                await loadRepos();
              }
            }
          } catch {
            clearInterval(poll);
            setIsAnalyzing(false);
          }
        }, 1000);
      } catch {
        setIsAnalyzing(false);
        setAnalyzeProgress(undefined);
      }
    },
    [loadRepos],
  );

  const handleSendMessage = useCallback(
    async (message: string, repo?: string): Promise<string> => {
      try {
        const data = await fetchChat(message, repo ?? selectedRepo ?? undefined);
        return data.response;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : 'Failed to get response'}`;
      }
    },
    [selectedRepo],
  );

  return (
    <div style={styles.app}>
      <RepoSidebar
        repos={repos}
        selectedRepo={selectedRepo}
        onSelectRepo={handleSelectRepo}
        onRefresh={loadRepos}
        onAnalyze={handleAnalyze}
        isAnalyzing={isAnalyzing}
        analyzeProgress={analyzeProgress}
      />
      <div style={styles.main}>
        {!selectedRepo ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyTitle}>Astrolabe</div>
            <div style={styles.emptySubtitle}>
              Codebase Knowledge Graph
            </div>
            <div style={styles.emptyHint}>
              Select a repository from the sidebar to explore its graph,
              or analyze a new one using the input below the repo list.
            </div>
          </div>
        ) : (
          <GraphCanvas
            nodes={nodes}
            edges={edges}
            onNodeSelect={(node) => {
              // Node selection handled internally by GraphCanvas
            }}
          />
        )}
        <button
          style={{
            ...styles.fab,
            bottom: chatVisible ? 420 : 16,
          }}
          onClick={() => setSearchVisible(!searchVisible)}
          title="Search & Impact"
        >
          🔍
        </button>
        <button
          style={styles.fab}
          onClick={() => setChatVisible(!chatVisible)}
          title="AI Assistant"
        >
          💬
        </button>
        <ChatPanel
          repos={repos}
          selectedRepo={selectedRepo}
          onSendMessage={handleSendMessage}
          isVisible={chatVisible}
          onToggle={() => setChatVisible(!chatVisible)}
        />
        <SearchPanel
          selectedRepo={selectedRepo}
          isVisible={searchVisible}
          onToggle={() => setSearchVisible(!searchVisible)}
        />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    height: '100vh',
    width: '100vw',
    backgroundColor: '#1e1e1e',
    color: '#d4d4d4',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  main: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 16,
  },
  emptyTitle: {
    fontSize: 48,
    fontWeight: 300,
    color: '#888',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  emptySubtitle: {
    fontSize: 16,
    color: '#666',
  },
  emptyHint: {
    fontSize: 13,
    color: '#555',
    maxWidth: 360,
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 1.6,
  },
  fab: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    border: 'none',
    backgroundColor: '#007acc',
    color: '#fff',
    fontSize: 18,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
    zIndex: 100,
  },
};
