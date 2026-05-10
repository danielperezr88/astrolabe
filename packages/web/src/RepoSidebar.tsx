// ---------------------------------------------------------------------------
// RepoSidebar — Repository selection & management panel
// Dark theme, 280px fixed sidebar, integrated design tokens
// ---------------------------------------------------------------------------

import { type FC, useState, useMemo } from 'react';
import type { RepoInfo } from './types';

// ---------------------------------------------------------------------------
// Prop types
// ---------------------------------------------------------------------------

interface AnalyzeProgress {
  phase: string;
  percent: number;
  message: string;
}

interface RepoSidebarProps {
  repos: RepoInfo[];
  selectedRepo: string | null;
  onSelectRepo: (name: string) => void;
  onRefresh: () => void;
  onAnalyze: (path: string) => void;
  isAnalyzing: boolean;
  analyzeProgress?: AnalyzeProgress;
}

// ---------------------------------------------------------------------------
// Design tokens — embedded as a <style> block (no external CSS files)
// ---------------------------------------------------------------------------

const TOKENS = `
  :root {
    --rp-bg-panel:        #252526;
    --rp-bg-main:         #1e1e1e;
    --rp-bg-hover:        #2d2d2d;
    --rp-bg-selected:     #2a2d2e;
    --rp-bg-input:        #3c3c3c;
    --rp-border:          #3e3e42;
    --rp-border-light:    #474747;
    --rp-accent:          #007acc;
    --rp-accent-dim:      rgba(0,122,204,0.15);
    --rp-text-primary:    #d4d4d4;
    --rp-text-secondary:  #888;
    --rp-text-dim:        #6e6e6e;
    --rp-text-muted:      #5a5a5a;
    --rp-success:         #2ecc71;
    --rp-success-bg:      rgba(46,204,113,0.12);
    --rp-warning:         #f39c12;
    --rp-warning-bg:      rgba(243,156,18,0.12);
    --rp-progress-bg:     #333;
    --rp-progress-fill:   #007acc;
    --rp-radius-sm:       3px;
    --rp-radius-md:       6px;
    --rp-transition:      150ms ease;
    --rp-scrollbar-thumb: #424242;
    --rp-scrollbar-track: transparent;
    --rp-scrollbar-hover: #555;
  }
`;

const STYLES = `
  .rp-sidebar {
    width: 280px;
    min-width: 280px;
    height: 100vh;
    background: var(--rp-bg-panel);
    border-right: 1px solid var(--rp-border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }

  /* ── Header ────────────────────────────────────── */

  .rp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--rp-border);
    flex-shrink: 0;
  }

  .rp-title {
    color: var(--rp-text-primary);
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0;
  }

  .rp-refresh {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: var(--rp-radius-sm);
    background: transparent;
    color: var(--rp-text-secondary);
    cursor: pointer;
    transition: background var(--rp-transition), color var(--rp-transition);
  }

  .rp-refresh:hover {
    background: var(--rp-bg-hover);
    color: var(--rp-text-primary);
  }

  .rp-refresh:active {
    background: var(--rp-bg-input);
  }

  .rp-refresh svg {
    width: 16px;
    height: 16px;
  }

  /* ── Search bar ────────────────────────────────── */

  .rp-search-wrap {
    padding: 8px 12px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--rp-border);
  }

  .rp-search {
    width: 100%;
    padding: 6px 10px;
    font-size: 13px;
    color: var(--rp-text-primary);
    background: var(--rp-bg-input);
    border: 1px solid transparent;
    border-radius: var(--rp-radius-sm);
    outline: none;
    box-sizing: border-box;
    transition: border-color var(--rp-transition), background var(--rp-transition);
  }

  .rp-search::placeholder {
    color: var(--rp-text-dim);
  }

  .rp-search:focus {
    border-color: var(--rp-accent);
    background: var(--rp-bg-panel);
  }

  /* ── Repo list ─────────────────────────────────── */

  .rp-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }

  .rp-list::-webkit-scrollbar {
    width: 6px;
  }

  .rp-list::-webkit-scrollbar-track {
    background: var(--rp-scrollbar-track);
  }

  .rp-list::-webkit-scrollbar-thumb {
    background: var(--rp-scrollbar-thumb);
    border-radius: 3px;
  }

  .rp-list::-webkit-scrollbar-thumb:hover {
    background: var(--rp-scrollbar-hover);
  }

  /* ── Repo item ─────────────────────────────────── */

  .rp-item {
    padding: 10px 16px;
    cursor: pointer;
    border-left: 3px solid transparent;
    transition: background var(--rp-transition), border-color var(--rp-transition);
    user-select: none;
  }

  .rp-item:hover {
    background: var(--rp-bg-hover);
  }

  .rp-item--selected {
    background: var(--rp-bg-selected);
    border-left-color: var(--rp-accent);
  }

  .rp-item--selected:hover {
    background: var(--rp-bg-selected);
  }

  .rp-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .rp-item-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--rp-text-primary);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    margin-right: 8px;
  }

  .rp-item-path {
    font-size: 11px;
    color: var(--rp-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-bottom: 4px;
  }

  .rp-item-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--rp-text-dim);
  }

  /* ── Status badge ──────────────────────────────── */

  .rp-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    line-height: 1.6;
    flex-shrink: 0;
  }

  .rp-badge--indexed {
    color: var(--rp-success);
    background: var(--rp-success-bg);
  }

  .rp-badge--stale {
    color: var(--rp-warning);
    background: var(--rp-warning-bg);
  }

  .rp-badge-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
  }

  /* ── Analyze section ───────────────────────────── */

  .rp-analyze-section {
    padding: 12px 16px;
    border-top: 1px solid var(--rp-border);
    flex-shrink: 0;
  }

  .rp-analyze-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--rp-text-dim);
    margin-bottom: 8px;
  }

  .rp-analyze-row {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }

  .rp-analyze-input {
    flex: 1;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--rp-text-primary);
    background: var(--rp-bg-input);
    border: 1px solid var(--rp-border-light);
    border-radius: var(--rp-radius-sm);
    outline: none;
    box-sizing: border-box;
    transition: border-color var(--rp-transition);
  }

  .rp-analyze-input::placeholder {
    color: var(--rp-text-dim);
  }

  .rp-analyze-input:focus {
    border-color: var(--rp-accent);
  }

  .rp-analyze-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .rp-analyze-btn {
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 600;
    color: #fff;
    background: var(--rp-accent);
    border: none;
    border-radius: var(--rp-radius-sm);
    cursor: pointer;
    white-space: nowrap;
    transition: background var(--rp-transition), opacity var(--rp-transition);
  }

  .rp-analyze-btn:hover:not(:disabled) {
    background: #1a8ad4;
  }

  .rp-analyze-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ── Progress bar ──────────────────────────────── */

  .rp-progress-wrap {
    margin-top: 4px;
  }

  .rp-progress-phase {
    font-size: 11px;
    color: var(--rp-text-secondary);
    margin-bottom: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rp-progress-track {
    width: 100%;
    height: 4px;
    background: var(--rp-progress-bg);
    border-radius: 2px;
    overflow: hidden;
  }

  .rp-progress-fill {
    height: 100%;
    background: var(--rp-progress-fill);
    border-radius: 2px;
    transition: width 300ms ease;
  }

  .rp-progress-pct {
    font-size: 10px;
    color: var(--rp-text-dim);
    margin-top: 3px;
    text-align: right;
  }

  /* ── Empty state ───────────────────────────────── */

  .rp-empty {
    padding: 32px 24px;
    text-align: center;
    color: var(--rp-text-dim);
    font-size: 13px;
    line-height: 1.5;
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    const diffHrs = Math.floor(diffMs / 3_600_000);
    const diffDays = Math.floor(diffMs / 86_400_000);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHrs < 24) return `${diffHrs}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

/** A repo is "stale" if it has never been indexed (no indexedAt). */
function repoStatus(repo: RepoInfo): 'indexed' | 'stale' {
  return repo.indexedAt ? 'indexed' : 'stale';
}

// ---------------------------------------------------------------------------
// Status badge sub-component
// ---------------------------------------------------------------------------

const StatusBadge: FC<{ status: 'indexed' | 'stale' }> = ({ status }) => {
  const label = status === 'indexed' ? 'Indexed' : 'Stale';
  return (
    <span className={`rp-badge rp-badge--${status}`}>
      <span className="rp-badge-dot" />
      {label}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const RepoSidebar: FC<RepoSidebarProps> = ({
  repos,
  selectedRepo,
  onSelectRepo,
  onRefresh,
  onAnalyze,
  isAnalyzing,
  analyzeProgress,
}) => {
  const [search, setSearch] = useState('');
  const [analyzePath, setAnalyzePath] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q),
    );
  }, [repos, search]);

  const handleAnalyze = () => {
    const trimmed = analyzePath.trim();
    if (!trimmed || isAnalyzing) return;
    onAnalyze(trimmed);
  };

  const handleAnalyzeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleAnalyze();
  };

  return (
    <>
      <style>{TOKENS}{STYLES}</style>
      <aside className="rp-sidebar">
        {/* Header */}
        <div className="rp-header">
          <h2 className="rp-title">Repositories</h2>
          <button
            className="rp-refresh"
            onClick={onRefresh}
            title="Refresh repository list"
            aria-label="Refresh repository list"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 8a6 6 0 0 1 10.47-4M14 8a6 6 0 0 1-10.47 4" />
              <path d="M14 2v4h-4M2 14v-4h4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="rp-search-wrap">
          <input
            className="rp-search"
            type="text"
            placeholder="Filter repositories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Filter repositories"
          />
        </div>

        {/* Repo list */}
        <div className="rp-list">
          {filtered.length === 0 ? (
            <div className="rp-empty">
              {repos.length === 0
                ? 'No repositories indexed. Use the input below to analyze a repository.'
                : 'No repositories match your filter.'}
            </div>
          ) : (
            filtered.map((repo) => {
              const status = repoStatus(repo);
              const isSelected = selectedRepo === repo.name;
              return (
                <div
                  key={repo.name}
                  className={`rp-item${isSelected ? ' rp-item--selected' : ''}`}
                  onClick={() => onSelectRepo(repo.name)}
                  role="option"
                  aria-selected={isSelected}
                >
                  <div className="rp-item-header">
                    <span className="rp-item-name" title={repo.name}>
                      {repo.name}
                    </span>
                    <StatusBadge status={status} />
                  </div>
                  <div className="rp-item-path" title={repo.path}>
                    {repo.path}
                  </div>
                  <div className="rp-item-meta">
                    {repo.indexedAt && (
                      <span>Indexed {formatDate(repo.indexedAt)}</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Analyze section */}
        <div className="rp-analyze-section">
          <div className="rp-analyze-label">Analyze Repository</div>

          <div className="rp-analyze-row">
            <input
              className="rp-analyze-input"
              type="text"
              placeholder="Path to repository…"
              value={analyzePath}
              onChange={(e) => setAnalyzePath(e.target.value)}
              onKeyDown={handleAnalyzeKeyDown}
              disabled={isAnalyzing}
              aria-label="Repository path to analyze"
            />
            <button
              className="rp-analyze-btn"
              onClick={handleAnalyze}
              disabled={isAnalyzing || !analyzePath.trim()}
            >
              {isAnalyzing ? 'Analyzing…' : 'Analyze'}
            </button>
          </div>

          {isAnalyzing && analyzeProgress && (
            <div className="rp-progress-wrap">
              <div className="rp-progress-phase">
                {analyzeProgress.phase}
                {analyzeProgress.message && ` — ${analyzeProgress.message}`}
              </div>
              <div className="rp-progress-track">
                <div
                  className="rp-progress-fill"
                  style={{ width: `${Math.min(100, Math.max(0, analyzeProgress.percent))}%` }}
                />
              </div>
              <div className="rp-progress-pct">
                {Math.round(analyzeProgress.percent)}%
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
};

export default RepoSidebar;
