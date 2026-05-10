import { useState, useRef, useEffect, useCallback } from 'react';
import type { RepoInfo } from './types';

// ---------------------------------------------------------------------------
// Internal message type (adds local metadata to the API ChatMessage shape)
// ---------------------------------------------------------------------------

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ChatPanelProps {
  repos: RepoInfo[];
  selectedRepo: string | null;
  onSendMessage: (message: string, repo?: string) => Promise<string>;
  isVisible: boolean;
  onToggle: () => void;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  // ── Collapsed badge ────────────────────────────────────────────────────
  badge: {
    position: 'fixed' as const,
    bottom: 16,
    right: 16,
    zIndex: 100,
    width: 44,
    height: 44,
    borderRadius: '50%',
    background: '#1f6feb',
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1.2rem',
    boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease',
  },

  // ── Panel ──────────────────────────────────────────────────────────────
  panel: {
    position: 'fixed' as const,
    bottom: 16,
    right: 16,
    zIndex: 100,
    width: 360,
    maxHeight: 500,
    background: '#161b22',
    border: '1px solid #21262d',
    borderRadius: 8,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
  },

  // ── Header ─────────────────────────────────────────────────────────────
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.6rem 0.75rem',
    background: '#0d1117',
    borderBottom: '1px solid #21262d',
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: '#58a6ff',
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#8b949e',
    cursor: 'pointer',
    fontSize: '1.1rem',
    padding: '0.15rem 0.35rem',
    borderRadius: 4,
    lineHeight: 1,
  },

  // ── Messages area ──────────────────────────────────────────────────────
  messagesArea: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '0.75rem',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.6rem',
    minHeight: 0,
  },
  messageRow: {
    display: 'flex',
    gap: '0.5rem',
    maxWidth: '100%',
  },
  avatar: {
    width: 26,
    height: 26,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.7rem',
    fontWeight: 700,
    flexShrink: 0,
  },
  userAvatar: {
    background: '#1f6feb22',
    color: '#58a6ff',
    border: '1px solid #1f6feb44',
  },
  assistantAvatar: {
    background: '#3fb95022',
    color: '#3fb950',
    border: '1px solid #3fb95044',
  },
  bubble: {
    padding: '0.5rem 0.65rem',
    borderRadius: 6,
    fontSize: '0.82rem',
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    maxWidth: '85%',
  },
  userBubble: {
    background: '#264f78',
    color: '#e6edf3',
    borderTopRightRadius: 2,
  },
  assistantBubble: {
    background: '#3c3c3c',
    color: '#d4d4d4',
    borderTopLeftRadius: 2,
  },
  timestamp: {
    fontSize: '0.65rem',
    color: '#484f58',
    marginTop: '0.15rem',
  },

  // ── Empty state ────────────────────────────────────────────────────────
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1.5rem',
    color: '#484f58',
    fontSize: '0.82rem',
    textAlign: 'center' as const,
    lineHeight: 1.5,
    gap: '0.5rem',
  },
  emptyIcon: {
    fontSize: '1.8rem',
    marginBottom: '0.25rem',
    opacity: 0.4,
  },

  // ── Input area ─────────────────────────────────────────────────────────
  inputArea: {
    padding: '0.6rem 0.75rem',
    borderTop: '1px solid #21262d',
    background: '#0d1117',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.4rem',
  },
  select: {
    width: '100%',
    padding: '0.3rem 0.5rem',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 4,
    color: '#c9d1d9',
    fontSize: '0.75rem',
    outline: 'none',
    cursor: 'pointer',
  },
  inputRow: {
    display: 'flex',
    gap: '0.4rem',
  },
  textarea: {
    flex: 1,
    padding: '0.45rem 0.6rem',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 6,
    color: '#c9d1d9',
    fontSize: '0.82rem',
    outline: 'none',
    resize: 'none' as const,
    minHeight: 36,
    maxHeight: 100,
    fontFamily: 'inherit',
    lineHeight: 1.4,
  },
  sendBtn: {
    padding: '0.4rem 0.85rem',
    background: '#238636',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  },
  sendBtnDisabled: {
    padding: '0.4rem 0.85rem',
    background: '#21262d',
    border: 'none',
    borderRadius: 6,
    color: '#484f58',
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: 'default',
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  },

  // ── Loading dots ──────────────────────────────────────────────────────
  loadingContainer: {
    display: 'flex',
    gap: '0.35rem',
    padding: '0.4rem 0.65rem',
    alignItems: 'center',
  },
  loadingDot: (delay: number) => ({
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: '#8b949e',
    animation: `chatDotPulse 1.2s ${delay}s infinite ease-in-out`,
  }),

  // ── Repo badge ─────────────────────────────────────────────────────────
  repoBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.2rem',
    padding: '0.15rem 0.4rem',
    background: '#1f6feb22',
    border: '1px solid #1f6feb44',
    borderRadius: 3,
    fontSize: '0.7rem',
    color: '#58a6ff',
    marginBottom: '0.4rem',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatPanel({
  repos,
  selectedRepo,
  onSendMessage,
  isVisible,
  onToggle,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [repo, setRepo] = useState<string>(selectedRepo ?? '');
  const [loading, setLoading] = useState(false);
  const [hoveredMsg, setHoveredMsg] = useState<number | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync external selectedRepo when it changes
  useEffect(() => {
    if (selectedRepo !== null && selectedRepo !== repo) {
      setRepo(selectedRepo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus textarea when panel opens
  useEffect(() => {
    if (isVisible) {
      // Small delay so the transition finishes
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [isVisible]);

  // Inject keyframes for loading dots
  useEffect(() => {
    if (!document.getElementById('chat-dot-keyframes')) {
      const style = document.createElement('style');
      style.id = 'chat-dot-keyframes';
      style.textContent = `
        @keyframes chatDotPulse {
          0%, 100% { opacity: 0.25; transform: scale(0.85); }
          50% { opacity: 1; transform: scale(1.15); }
        }
        .chat-scroll::-webkit-scrollbar { width: 5px; }
        .chat-scroll::-webkit-scrollbar-track { background: transparent; }
        .chat-scroll::-webkit-scrollbar-thumb { background: #30363d; border-radius: 10px; }
        .chat-scroll::-webkit-scrollbar-thumb:hover { background: #484f58; }
      `;
      document.head.appendChild(style);
    }
  }, []);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const repoToSend = repo || undefined;
    const userMsg: Message = {
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const response = await onSendMessage(trimmed, repoToSend);
      const assistantMsg: Message = {
        role: 'assistant',
        content: response,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      const errMsg: Message = {
        role: 'assistant',
        content: 'Sorry, something went wrong. Please try again.',
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, repo, onSendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  // ── Collapsed badge ────────────────────────────────────────────────────
  if (!isVisible) {
    return (
      <button
        style={styles.badge}
        onClick={onToggle}
        title="Open AI Assistant"
        aria-label="Open AI Assistant"
      >
        AI
      </button>
    );
  }

  // ── Expanded panel ─────────────────────────────────────────────────────
  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>
          <span>AI Assistant</span>
        </span>
        <button
          style={styles.closeBtn}
          onClick={onToggle}
          title="Close"
          aria-label="Close AI Assistant"
        >
          ✕
        </button>
      </div>

      {/* Messages */}
      <div className="chat-scroll" style={styles.messagesArea}>
        {messages.length === 0 && !loading && (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>💡</div>
            <span>
              Ask questions about your codebase.{' '}
              {repos.length > 0
                ? 'Select a repository for context-aware answers.'
                : 'Index a repository to get started.'}
            </span>
            {repos.length === 0 && (
              <span style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                Run <code style={{ color: '#58a6ff', background: '#0d1117', padding: '0.1rem 0.3rem', borderRadius: 3 }}>astrolabe analyze .</code>
              </span>
            )}
          </div>
        )}

        {messages.map((msg, i) => {
          const isUser = msg.role === 'user';
          return (
            <div key={i}>
              {/* Repo badge on first message when a repo is selected */}
              {i === 0 && repo && (
                <div style={styles.repoBadge}>
                  Context: {repo}
                </div>
              )}
              <div
                style={{
                  ...styles.messageRow,
                  justifyContent: isUser ? 'flex-end' : 'flex-start',
                }}
                onMouseEnter={() => setHoveredMsg(i)}
                onMouseLeave={() => setHoveredMsg(null)}
              >
                {!isUser && (
                  <div style={{ ...styles.avatar, ...styles.assistantAvatar }}>
                    A
                  </div>
                )}
                <div
                  style={{
                    ...styles.bubble,
                    ...(isUser ? styles.userBubble : styles.assistantBubble),
                  }}
                >
                  <div>{msg.content}</div>
                  {hoveredMsg === i && (
                    <div
                      style={{
                        ...styles.timestamp,
                        textAlign: isUser ? 'right' : 'left',
                      }}
                    >
                      {formatTime(msg.timestamp)}
                    </div>
                  )}
                </div>
                {isUser && (
                  <div style={{ ...styles.avatar, ...styles.userAvatar }}>
                    U
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Loading indicator */}
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ ...styles.avatar, ...styles.assistantAvatar }}>A</div>
            <div style={styles.loadingContainer}>
              <span style={styles.loadingDot(0)} />
              <span style={styles.loadingDot(0.2)} />
              <span style={styles.loadingDot(0.4)} />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={styles.inputArea}>
        <select
          style={styles.select}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        >
          <option value="">No context (general chat)</option>
          {repos.map((r) => (
            <option key={r.path} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>

        <div style={styles.inputRow}>
          <textarea
            ref={textareaRef}
            style={styles.textarea}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your codebase..."
            rows={1}
            disabled={loading}
          />
          <button
            style={input.trim() && !loading ? styles.sendBtn : styles.sendBtnDisabled}
            onClick={send}
            disabled={!input.trim() || loading}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
