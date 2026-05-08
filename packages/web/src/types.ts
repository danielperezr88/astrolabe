// ---------------------------------------------------------------------------
// Astrolabe Web UI – TypeScript interfaces matching REST API response shapes
// ---------------------------------------------------------------------------

export interface RepoInfo {
  name: string;
  path: string;
  indexedAt?: string;
  lastCommit?: string;
}

export interface HealthResponse {
  status: string;
  uptime: string;
  repos: RepoInfo[];
}

export interface RepoContext {
  name: string;
  path: string;
  nodes: number;
  relationships: number;
  lastCommit?: string;
  indexedAt?: string;
  metaStale?: boolean;
}

export interface ClusterInfo {
  id: string;
  name: string;
  symbolCount: number;
  cohesion: number;
}

export interface ClustersResponse {
  clusters: ClusterInfo[];
}

export interface GraphNode {
  id: string;
  label: string;
  name: string;
  filePath?: string;
  startLine?: number;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: string;
  confidence?: number;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeCount: number;
  edgeCount: number;
}

export interface SearchResult {
  label: string;
  name: string;
  filePath?: string;
  rank?: number;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface ImpactNeighbor {
  direction: 'incoming' | 'outgoing';
  type: string;
  targetName: string;
}

export interface ImpactResult {
  id: string;
  label: string;
  name: string;
  filePath?: string;
  neighbors: ImpactNeighbor[];
}

export interface ImpactResponse {
  results: ImpactResult[];
}

export interface GrepMatch {
  filePath: string;
  line: number;
  text: string;
}

export interface GrepResponse {
  matches: number;
  results: GrepMatch[];
}

export interface AnalyzeJob {
  id: string;
  status: string;
  progress?: number;
  error?: string;
  repoName?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  message: string;
  repo?: string;
  history?: ChatMessage[];
}

export interface ChatResponse {
  response: string;
}
