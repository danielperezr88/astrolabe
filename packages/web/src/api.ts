// ---------------------------------------------------------------------------
// Astrolabe Web UI – Typed fetch functions for the REST API
// ---------------------------------------------------------------------------

import type {
  HealthResponse,
  RepoInfo,
  RepoContext,
  ClustersResponse,
  GraphResponse,
  SearchResponse,
  ImpactResponse,
  GrepResponse,
  AnalyzeJob,
  ChatMessage,
  ChatResponse,
} from './types';

/** API base path – empty string relies on Vite proxy or same-origin routing. */
const BASE_URL = '';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, init);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body || res.statusText);
  }

  return res.json() as Promise<T>;
}

async function requestJson<T>(
  path: string,
  method: string,
  body: unknown,
): Promise<T> {
  return request<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Health & status
// ---------------------------------------------------------------------------

export async function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health');
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export async function fetchRepos(): Promise<{ repos: RepoInfo[] }> {
  return request<{ repos: RepoInfo[] }>('/api/repos');
}

export async function fetchRepoContext(
  repoName: string,
): Promise<RepoContext> {
  return request<RepoContext>(
    `/api/repo/${encodeURIComponent(repoName)}/context`,
  );
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

export async function fetchClusters(
  repoName: string,
): Promise<ClustersResponse> {
  return request<ClustersResponse>(
    `/api/repo/${encodeURIComponent(repoName)}/clusters`,
  );
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export async function fetchGraph(
  repoName: string,
  cluster?: string,
): Promise<GraphResponse> {
  let path = `/api/repo/${encodeURIComponent(repoName)}/graph`;
  if (cluster) {
    path += `?cluster=${encodeURIComponent(cluster)}`;
  }
  return request<GraphResponse>(path);
}

// ---------------------------------------------------------------------------
// Query / search
// ---------------------------------------------------------------------------

export async function fetchQuery(
  repoName: string,
  query: string,
  limit?: number,
): Promise<SearchResponse> {
  return requestJson<SearchResponse>(
    `/api/repo/${encodeURIComponent(repoName)}/query`,
    'POST',
    { query, ...(limit !== undefined ? { limit } : {}) },
  );
}

// ---------------------------------------------------------------------------
// Impact analysis
// ---------------------------------------------------------------------------

export async function fetchImpact(
  repoName: string,
  name: string,
): Promise<ImpactResponse> {
  return requestJson<ImpactResponse>(
    `/api/repo/${encodeURIComponent(repoName)}/impact`,
    'POST',
    { name },
  );
}

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

export async function fetchGrep(
  repoName: string,
  pattern: string,
  limit?: number,
): Promise<GrepResponse> {
  const params = new URLSearchParams({ pattern });
  if (limit !== undefined) {
    params.set('limit', String(limit));
  }
  return request<GrepResponse>(
    `/api/repo/${encodeURIComponent(repoName)}/grep?${params.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function fetchChat(
  message: string,
  repo?: string,
  history?: ChatMessage[],
): Promise<ChatResponse> {
  return requestJson<ChatResponse>('/api/chat', 'POST', {
    message,
    repo,
    history,
  });
}

// ---------------------------------------------------------------------------
// Analysis jobs
// ---------------------------------------------------------------------------

export async function startAnalysis(
  path: string,
): Promise<{ jobId: string; status: string }> {
  return requestJson<{ jobId: string; status: string }>(
    '/api/analyze',
    'POST',
    { path },
  );
}

export async function pollJob(jobId: string): Promise<AnalyzeJob> {
  return request<AnalyzeJob>(
    `/api/analyze/${encodeURIComponent(jobId)}`,
  );
}

export async function cancelJob(
  jobId: string,
): Promise<{ id: string; status: string }> {
  return request<{ id: string; status: string }>(
    `/api/analyze/${encodeURIComponent(jobId)}`,
    { method: 'DELETE' },
  );
}
