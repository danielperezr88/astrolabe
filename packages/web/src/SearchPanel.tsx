import { useState, useCallback, useRef, useEffect } from 'react';
import type { SearchResult, ImpactResult, GrepMatch, ImpactNeighbor } from './types';
import { fetchQuery, fetchImpact, fetchGrep } from './api';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SearchPanelProps {
  selectedRepo: string | null;
  isVisible: boolean;
  onToggle: () => void;
}

// ---------------------------------------------------------------------------
// Design tokens – Astrolabe dark theme
// ---------------------------------------------------------------------------

const tokens = {
  bgPanel: '#252526',
  bgInput: '#3c3c3c',
  bgHover: '#2a2d2e',
  bgRow: '#2a2a2a',
  bgToast: '#333',
  border: '#3e3e42',
  borderFocus: '#007acc',
  accent: '#007acc',
  text: '#d4d4d4',
  textDim: '#888',
  textMuted: '#666',
  textBright: '#e0e0e0',
  incoming: '#3498db',
  outgoing: '#e67e22',
  error: '#e74c3c',
  placeholder: '#555',
  scrollbar: '#424242',
  scrollbarHover: '#555',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic colour from label string for result badges. */
function labelColor(label: string): string {
  const palette = [
    '#3498db', '#2ecc71', '#e67e22', '#9b59b6',
    '#1abc9c', '#f1c40f', '#e74c3c', '#00bcd4',
    '#ff9800', '#8bc34a', '#ff5722', '#607d8b',
  ];
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) & 0xffffffff;
  }
  return palette[Math.abs(hash) % palette.length];
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SearchPanel({
  selectedRepo,
  isVisible,
  onToggle,
}: SearchPanelProps) {
  // ---- Tab state ----------------------------------------------------------
  const [activeTab, setActiveTab] = useState<'search' | 'impact'>('search');

  // ---- Search tab state ---------------------------------------------------
  const [searchInput, setSearchInput] = useState('');
  const [searchType, setSearchType] = useState<'symbols' | 'code'>('symbols');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [grepResults, setGrepResults] = useState<GrepMatch[]>([]);
  const [grepCount, setGrepCount] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // ---- Impact tab state ---------------------------------------------------
  const [impactInput, setImpactInput] = useState('');
  const [impactResults, setImpactResults] = useState<ImpactResult[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [expandedImpacts, setExpandedImpacts] = useState<Set<string>>(
    new Set(),
  );

  // ---- Toast --------------------------------------------------------------
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // ---- Search handler -----------------------------------------------------
  const handleSearch = useCallback(async () => {
    if (!selectedRepo || !searchInput.trim()) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      if (searchType === 'symbols') {
        const res = await fetchQuery(selectedRepo, searchInput.trim(), 50);
        setSearchResults(res.results ?? []);
        setGrepResults([]);
        setGrepCount(0);
      } else {
        const res = await fetchGrep(selectedRepo, searchInput.trim(), 50);
        setGrepResults(res.results ?? []);
        setGrepCount(res.matches ?? 0);
        setSearchResults([]);
      }
    } catch (err) {
      setSearchError(
        err instanceof Error ? err.message : 'Search failed',
      );
    } finally {
      setIsSearching(false);
    }
  }, [selectedRepo, searchInput, searchType]);

  // Search on Enter
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSearch();
    },
    [handleSearch],
  );

  // ---- Impact handler -----------------------------------------------------
  const handleImpact = useCallback(async () => {
    if (!selectedRepo || !impactInput.trim()) return;
    setIsAnalyzing(true);
    setImpactError(null);
    try {
      const res = await fetchImpact(selectedRepo, impactInput.trim());
      setImpactResults(res.results ?? []);
      // Auto-expand first result
      if (res.results && res.results.length > 0) {
        setExpandedImpacts(new Set([res.results[0].id]));
      }
    } catch (err) {
      setImpactError(
        err instanceof Error ? err.message : 'Impact analysis failed',
      );
    } finally {
      setIsAnalyzing(false);
    }
  }, [selectedRepo, impactInput]);

  // ---- Copy handler -------------------------------------------------------
  const handleCopy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(`Copied: ${truncate(text, 40)}`);
      } catch {
        showToast('Copy failed');
      }
    },
    [showToast],
  );

  // ---- Toggle impact expansion -------------------------------------------
  const toggleExpand = useCallback((id: string) => {
    setExpandedImpacts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ---- Panel visibility ---------------------------------------------------
  if (!isVisible) {
    return (
      <button
        onClick={onToggle}
        title="Open Search & Impact"
        style={s.fab}
        aria-label="Open search panel"
      >
        <svg
          width={20}
          height={20}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx={11} cy={11} r={7} />
          <line x1={20} y1={20} x2={17} y2={17} />
        </svg>
      </button>
    );
  }

  // ---- Panel content ------------------------------------------------------
  const disabled = !selectedRepo;

  return (
    <>
      {/* ---- Side Panel -------------------------------------------------- */}
      <aside style={s.panel}>
        {/* Header */}
        <div style={s.header}>
          <span style={s.headerTitle}>Search</span>
          <button onClick={onToggle} style={s.closeBtn} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div style={s.tabs}>
          <button
            onClick={() => setActiveTab('search')}
            style={{
              ...s.tab,
              ...(activeTab === 'search' ? s.tabActive : {}),
            }}
          >
            Search
          </button>
          <button
            onClick={() => setActiveTab('impact')}
            style={{
              ...s.tab,
              ...(activeTab === 'impact' ? s.tabActive : {}),
            }}
          >
            Impact
            {impactResults.length > 0 && (
              <span style={s.countBadge}>{impactResults.length}</span>
            )}
          </button>
        </div>

        {/* ================================================================ */}
        {/* Search tab */}
        {/* ================================================================ */}
        {activeTab === 'search' && (
          <div style={s.tabContent}>
            {/* Type selector + input */}
            <div style={s.searchBar}>
              <div style={s.typeSelector}>
                <button
                  onClick={() => setSearchType('symbols')}
                  style={{
                    ...s.typeBtn,
                    ...(searchType === 'symbols' ? s.typeBtnActive : {}),
                  }}
                  disabled={disabled}
                >
                  Symbols
                </button>
                <button
                  onClick={() => setSearchType('code')}
                  style={{
                    ...s.typeBtn,
                    ...(searchType === 'code' ? s.typeBtnActive : {}),
                  }}
                  disabled={disabled}
                >
                  Code
                </button>
              </div>
              <div style={s.inputRow}>
                <svg
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={tokens.placeholder}
                  strokeWidth={2}
                  style={{ flexShrink: 0 }}
                >
                  <circle cx={11} cy={11} r={7} />
                  <line x1={20} y1={20} x2={17} y2={17} />
                </svg>
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={
                    disabled
                      ? 'Select a repository first'
                      : searchType === 'symbols'
                        ? 'Search symbols…'
                        : 'Search code patterns…'
                  }
                  disabled={disabled}
                  style={s.input}
                />
                <button
                  onClick={handleSearch}
                  disabled={disabled || isSearching || !searchInput.trim()}
                  style={s.actionBtn}
                >
                  {isSearching ? '…' : 'Go'}
                </button>
              </div>
            </div>

            {/* Disabled overlay */}
            {disabled && (
              <div style={s.emptyState}>
                <p style={s.emptyText}>Select a repository first</p>
              </div>
            )}

            {/* Loading */}
            {!disabled && isSearching && (
              <div style={s.emptyState}>
                <div style={s.spinner} />
                <p style={s.emptyText}>Searching…</p>
              </div>
            )}

            {/* Error */}
            {!disabled && !isSearching && searchError && (
              <div style={s.emptyState}>
                <p style={s.errorText}>{searchError}</p>
              </div>
            )}

            {/* Empty */}
            {!disabled &&
              !isSearching &&
              !searchError &&
              searchResults.length === 0 &&
              grepResults.length === 0 && (
                <div style={s.emptyState}>
                  <p style={s.emptyText}>
                    Search for symbols or code patterns
                  </p>
                </div>
              )}

            {/* Symbol results */}
            {!disabled &&
              !isSearching &&
              searchResults.length > 0 && (
                <div style={s.resultsArea}>
                  <div style={s.resultsCount}>
                    {searchResults.length} result
                    {searchResults.length !== 1 ? 's' : ''}
                  </div>
                  {searchResults.map((r, i) => (
                    <div
                      key={`${r.name}-${i}`}
                      style={s.resultRow}
                      onClick={() => handleCopy(r.name)}
                      title="Click to copy name"
                    >
                      <span style={s.resultName}>
                        {truncate(r.name, 32)}
                      </span>
                      <span
                        style={{
                          ...s.labelBadge,
                          backgroundColor: labelColor(r.label),
                        }}
                      >
                        {r.label}
                      </span>
                      {r.filePath && (
                        <span style={s.resultMeta}>
                          {truncate(r.filePath, 24)}
                        </span>
                      )}
                      {r.rank !== undefined && (
                        <span style={s.resultRank}>
                          #{r.rank.toFixed(2)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

            {/* Grep results */}
            {!disabled &&
              !isSearching &&
              grepResults.length > 0 && (
                <div style={s.resultsArea}>
                  <div style={s.resultsCount}>
                    {grepResults.length} match
                    {grepResults.length !== 1 ? 'es' : ''}
                    {grepCount > grepResults.length
                      ? ` (of ${grepCount} total)`
                      : ''}
                  </div>
                  {grepResults.map((m, i) => (
                    <div
                      key={`${m.filePath}:${m.line}-${i}`}
                      style={s.resultRow}
                      onClick={() =>
                        handleCopy(`${m.filePath}:${m.line}`)
                      }
                      title="Click to copy location"
                    >
                      <span style={s.grepLine}>L{m.line}</span>
                      <span style={s.grepText}>
                        {truncate(m.text.trim(), 48)}
                      </span>
                      <span style={s.grepPath}>
                        {truncate(m.filePath, 20)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
          </div>
        )}

        {/* ================================================================ */}
        {/* Impact tab */}
        {/* ================================================================ */}
        {activeTab === 'impact' && (
          <div style={s.tabContent}>
            {/* Input */}
            <div style={s.impactBar}>
              <div style={s.inputRow}>
                <input
                  type="text"
                  value={impactInput}
                  onChange={(e) => setImpactInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleImpact();
                  }}
                  placeholder={
                    disabled
                      ? 'Select a repository first'
                      : 'Symbol name…'
                  }
                  disabled={disabled}
                  style={s.input}
                />
                <button
                  onClick={handleImpact}
                  disabled={disabled || isAnalyzing || !impactInput.trim()}
                  style={s.actionBtn}
                >
                  {isAnalyzing ? '…' : 'Analyze'}
                </button>
              </div>
            </div>

            {/* Disabled */}
            {disabled && (
              <div style={s.emptyState}>
                <p style={s.emptyText}>Select a repository first</p>
              </div>
            )}

            {/* Loading */}
            {!disabled && isAnalyzing && (
              <div style={s.emptyState}>
                <div style={s.spinner} />
                <p style={s.emptyText}>Analyzing impact…</p>
              </div>
            )}

            {/* Error */}
            {!disabled && !isAnalyzing && impactError && (
              <div style={s.emptyState}>
                <p style={s.errorText}>{impactError}</p>
              </div>
            )}

            {/* Empty */}
            {!disabled &&
              !isAnalyzing &&
              !impactError &&
              impactResults.length === 0 && (
                <div style={s.emptyState}>
                  <p style={s.emptyText}>
                    Enter a symbol name to see its impact radius
                  </p>
                </div>
              )}

            {/* Impact results */}
            {!disabled &&
              !isAnalyzing &&
              impactResults.length > 0 && (
                <div style={s.resultsArea}>
                  {impactResults.map((impact) => {
                    const isExpanded = expandedImpacts.has(impact.id);
                    return (
                      <div key={impact.id} style={s.impactCard}>
                        {/* Header – clickable */}
                        <div
                          style={s.impactHeader}
                          onClick={() => toggleExpand(impact.id)}
                        >
                          <span style={s.impactChevron}>
                            {isExpanded ? '▾' : '▸'}
                          </span>
                          <span style={s.impactName}>
                            {truncate(impact.name, 28)}
                          </span>
                          <span
                            style={{
                              ...s.labelBadge,
                              backgroundColor: labelColor(impact.label),
                            }}
                          >
                            {impact.label}
                          </span>
                          {impact.filePath && (
                            <span style={s.impactPath}>
                              {truncate(impact.filePath, 20)}
                            </span>
                          )}
                        </div>

                        {/* Neighbors */}
                        {isExpanded && (
                          <div style={s.neighborList}>
                            {impact.neighbors.length === 0 ? (
                              <div style={s.noNeighbors}>
                                No connections
                              </div>
                            ) : (
                              impact.neighbors.map((n, j) => (
                                <NeighborRow
                                  key={`${n.targetName}-${j}`}
                                  neighbor={n}
                                  onCopy={handleCopy}
                                />
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
          </div>
        )}
      </aside>

      {/* ---- Toast -------------------------------------------------------- */}
      {toast && <div style={s.toast}>{toast}</div>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Neighbor row sub-component
// ---------------------------------------------------------------------------

function NeighborRow({
  neighbor,
  onCopy,
}: {
  neighbor: ImpactNeighbor;
  onCopy: (text: string) => void;
}) {
  const isIncoming = neighbor.direction === 'incoming';

  return (
    <div
      style={s.neighborRow}
      onClick={() => onCopy(neighbor.targetName)}
      title="Click to copy name"
    >
      <span
        style={{
          ...s.directionBadge,
          backgroundColor: isIncoming
            ? tokens.incoming
            : tokens.outgoing,
        }}
      >
        {isIncoming ? 'IN' : 'OUT'}
      </span>
      <span style={s.neighborType}>
        {neighbor.type}
      </span>
      <span style={s.neighborTarget}>
        {truncate(neighbor.targetName, 28)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s: Record<string, React.CSSProperties> = {
  /* ---- FAB (collapsed state) ------------------------------------------- */
  fab: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    border: 'none',
    backgroundColor: tokens.accent,
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
    zIndex: 100,
  },

  /* ---- Panel ----------------------------------------------------------- */
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 360,
    height: '100%',
    backgroundColor: tokens.bgPanel,
    borderLeft: `1px solid ${tokens.border}`,
    display: 'flex',
    flexDirection: 'column',
    zIndex: 99,
    boxShadow: '-4px 0 16px rgba(0,0,0,0.3)',
  },

  /* ---- Header ---------------------------------------------------------- */
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderBottom: `1px solid ${tokens.border}`,
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: tokens.textDim,
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
  },
  closeBtn: {
    width: 28,
    height: 28,
    border: 'none',
    borderRadius: 4,
    backgroundColor: 'transparent',
    color: tokens.textDim,
    cursor: 'pointer',
    fontSize: 14,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ---- Tabs ------------------------------------------------------------ */
  tabs: {
    display: 'flex',
    borderBottom: `1px solid ${tokens.border}`,
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    padding: '8px 0',
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.textDim,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderBottom: '2px solid transparent',
    transition: 'color 0.15s, border-color 0.15s',
  },
  tabActive: {
    color: tokens.accent,
    borderBottomColor: tokens.accent,
  },
  countBadge: {
    fontSize: 10,
    fontWeight: 600,
    backgroundColor: tokens.accent,
    color: '#fff',
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 5px',
    lineHeight: '18px',
  },

  /* ---- Tab content area ------------------------------------------------ */
  tabContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },

  /* ---- Search bar ------------------------------------------------------ */
  searchBar: {
    padding: '10px 12px',
    borderBottom: `1px solid ${tokens.border}`,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  typeSelector: {
    display: 'flex',
    gap: 4,
  },
  typeBtn: {
    flex: 1,
    padding: '4px 0',
    border: `1px solid ${tokens.border}`,
    borderRadius: 4,
    backgroundColor: tokens.bgInput,
    color: tokens.textDim,
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
  },
  typeBtnActive: {
    backgroundColor: tokens.accent,
    color: '#fff',
    borderColor: tokens.accent,
  },
  inputRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    backgroundColor: tokens.bgInput,
    borderRadius: 4,
    border: `1px solid ${tokens.border}`,
    padding: '0 8px',
  },
  input: {
    flex: 1,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.text,
    fontSize: 13,
    padding: '7px 0',
    outline: 'none',
  },
  actionBtn: {
    padding: '4px 12px',
    border: 'none',
    borderRadius: 3,
    backgroundColor: tokens.accent,
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },

  /* ---- Impact bar ------------------------------------------------------ */
  impactBar: {
    padding: '10px 12px',
    borderBottom: `1px solid ${tokens.border}`,
    flexShrink: 0,
  },

  /* ---- Results area ---------------------------------------------------- */
  resultsArea: {
    flex: 1,
    overflowY: 'auto' as const,
    paddingBottom: 8,
  },
  resultsCount: {
    fontSize: 11,
    color: tokens.textMuted,
    padding: '8px 12px 4px',
    fontWeight: 500,
  },

  /* ---- Result rows (symbols) ------------------------------------------- */
  resultRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    cursor: 'pointer',
    borderBottom: `1px solid ${tokens.border}`,
    transition: 'background-color 0.1s',
    minHeight: 32,
  },
  resultName: {
    flex: 1,
    fontSize: 13,
    color: tokens.text,
    fontWeight: 500,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  labelBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: '#fff',
    padding: '2px 6px',
    borderRadius: 3,
    whiteSpace: 'nowrap' as const,
    textTransform: 'uppercase' as const,
  },
  resultMeta: {
    fontSize: 11,
    color: tokens.textMuted,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 120,
  },
  resultRank: {
    fontSize: 11,
    color: tokens.textDim,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
  },

  /* ---- Result rows (grep) ---------------------------------------------- */
  grepLine: {
    fontSize: 12,
    color: tokens.accent,
    fontWeight: 600,
    minWidth: 36,
    fontVariantNumeric: 'tabular-nums',
  },
  grepText: {
    flex: 1,
    fontSize: 12,
    color: tokens.textBright,
    fontFamily:
      "'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  grepPath: {
    fontSize: 10,
    color: tokens.textMuted,
    whiteSpace: 'nowrap' as const,
    maxWidth: 100,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  /* ---- Empty / loading / error states ---------------------------------- */
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  emptyText: {
    fontSize: 13,
    color: tokens.textMuted,
    textAlign: 'center' as const,
    lineHeight: 1.5,
  },
  errorText: {
    fontSize: 13,
    color: tokens.error,
    textAlign: 'center' as const,
  },
  spinner: {
    width: 24,
    height: 24,
    border: `2px solid ${tokens.border}`,
    borderTopColor: tokens.accent,
    borderRadius: '50%',
    animation: 'spin 0.7s linear infinite',
  },

  /* ---- Impact results -------------------------------------------------- */
  impactCard: {
    borderBottom: `1px solid ${tokens.border}`,
  },
  impactHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 12px',
    cursor: 'pointer',
    transition: 'background-color 0.1s',
    minHeight: 32,
  },
  impactChevron: {
    fontSize: 12,
    color: tokens.textDim,
    width: 16,
    flexShrink: 0,
    textAlign: 'center' as const,
  },
  impactName: {
    flex: 1,
    fontSize: 13,
    color: tokens.text,
    fontWeight: 500,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  impactPath: {
    fontSize: 10,
    color: tokens.textMuted,
    whiteSpace: 'nowrap' as const,
    maxWidth: 100,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  /* ---- Neighbors ------------------------------------------------------- */
  neighborList: {
    padding: '4px 0',
  },
  noNeighbors: {
    padding: '12px 24px',
    fontSize: 12,
    color: tokens.textMuted,
    fontStyle: 'italic' as const,
  },
  neighborRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 12px 5px 28px',
    cursor: 'pointer',
    transition: 'background-color 0.1s',
    minHeight: 28,
  },
  directionBadge: {
    fontSize: 9,
    fontWeight: 700,
    color: '#fff',
    padding: '1px 5px',
    borderRadius: 2,
    letterSpacing: 0.5,
    whiteSpace: 'nowrap' as const,
  },
  neighborType: {
    fontSize: 11,
    color: tokens.textDim,
    whiteSpace: 'nowrap' as const,
  },
  neighborTarget: {
    flex: 1,
    fontSize: 12,
    color: tokens.text,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  /* ---- Toast ----------------------------------------------------------- */
  toast: {
    position: 'fixed',
    bottom: 24,
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: tokens.bgToast,
    color: tokens.text,
    padding: '8px 20px',
    borderRadius: 6,
    fontSize: 13,
    boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
    zIndex: 200,
    pointerEvents: 'none',
    border: `1px solid ${tokens.border}`,
  },
};
