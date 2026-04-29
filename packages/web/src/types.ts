export interface RepoInfo {
  name: string;
  path: string;
  nodes: number;
  relationships: number;
  lastCommit: string;
  indexedAt: string;
  metaStale: boolean | null;
}

export interface ClusterInfo {
  id: string;
  name: string;
  symbolCount: number;
  cohesion: number;
}

export interface SearchResult {
  label: string;
  name: string;
  filePath: string;
  rank: number;
}

export interface ApiRepos {
  repos: Array<{ name: string; path: string; lastCommit: string; indexedAt: string }>;
}
