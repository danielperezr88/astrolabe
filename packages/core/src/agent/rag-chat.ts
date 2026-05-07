/**
 * RAG Chat Agent — LangChain-style conversational interface over the knowledge graph.
 *
 * Uses:
 * - BM25 full-text search for retrieval
 * - Graph traversal for context enrichment (impact, processes)
 * - OpenAI-compatible API for generation (streaming support)
 *
 * Exposes an MCP tool (`astrolabe.chat`) and HTTP endpoint (`POST /api/chat`).
 */

import { createFtsSearch, type FtsSearch } from '../search/fts.js';
import { createSqliteStore, type SqliteStore } from '../persist/sqlite.js';
import { loadRegistry, type RegistryEntry } from '../mcp/registry.js';

// ── LLM Client ────────────────────────────────────────────────────────────

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

const DEFAULT_LLM_CONFIG: LLMConfig = {
  apiKey: process.env.ASTROLABE_API_KEY || process.env.OPENAI_API_KEY || '',
  baseUrl: process.env.ASTROLABE_LLM_BASE_URL || 'https://api.openai.com/v1',
  model: process.env.ASTROLABE_MODEL || 'gpt-4o-mini',
  maxTokens: 4096,
  temperature: 0,
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  content: string;
  sources: Array<{ name: string; filePath: string; type: string; score: number }>;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Call an OpenAI-compatible LLM API.
 * Retries up to 3 times on transient failures.
 */
export async function callLLM(messages: ChatMessage[], config?: Partial<LLMConfig>): Promise<{ content: string; promptTokens?: number; completionTokens?: number }> {
  const cfg = { ...DEFAULT_LLM_CONFIG, ...config };
  if (!cfg.apiKey) throw new Error('No API key configured. Set ASTROLABE_API_KEY or OPENAI_API_KEY.');

  const url = `${cfg.baseUrl.replace(/\/*$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
  };

  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');
        if (response.status === 429 && attempt < MAX_RETRIES - 1) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
          await sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 3000);
          continue;
        }
        if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
          await sleep((attempt + 1) * 2000);
          continue;
        }
        throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 500)}`);
      }

      const json = (await response.json()) as any;
      const choice = json.choices?.[0];
      if (!choice?.message?.content) throw new Error('LLM returned empty response');

      return {
        content: choice.message.content,
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
      };
    } catch (err: any) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1 && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.message?.includes('fetch'))) {
        await sleep((attempt + 1) * 3000);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('LLM call failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Retrieval Pipeline ────────────────────────────────────────────────────

interface RetrievalResult {
  sources: Array<{ name: string; filePath: string; type: string; score: number }>;
  context: string;
}

function retrieveContext(fts: FtsSearch, query: string, limit = 10): RetrievalResult {
  const results = fts.search(query, limit);
  if (results.length === 0) return { sources: [], context: 'No matching symbols found in the knowledge graph.' };

  const sources = results.map((r) => ({ name: r.name, filePath: r.filePath, type: r.label, score: r.score }));
  const context = results
    .map((r, i) => `${i + 1}. **${r.name}** (${r.label}) in \`${r.filePath}\` [score: ${r.score.toFixed(3)}]`)
    .join('\n');

  return { sources, context };
}

// ── System Prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Astrolabe, an AI assistant with deep knowledge of the user's codebase via a knowledge graph.

You have access to indexed code information including:
- Function definitions, class hierarchies, imports, and call graphs
- Execution flow processes and community groupings
- Impact analysis for change risk assessment

When answering questions:
1. Use the provided code context to give precise, grounded answers
2. Reference specific file paths and symbol names from the context
3. If the context is insufficient, say so clearly
4. For architecture questions, reference the communities/modules mentioned
5. For "what if I change X" questions, reference the impact analysis data
6. Keep answers concise but precise — cite sources from the context`;

// ── Chat Agent ────────────────────────────────────────────────────────────

interface ChatSession {
  store: SqliteStore;
  fts: FtsSearch;
  entry: RegistryEntry;
}

function createChatSession(repoName?: string): ChatSession {
  const entries = loadRegistry();
  const name = repoName ?? entries[0]?.name;
  if (!name) throw new Error('No indexed repositories. Run `astrolabe analyze` first.');

  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`Repository "${name}" not found.`);

  const store = createSqliteStore(entry.dbPath);
  const fts = createFtsSearch(entry.dbPath);
  return { store, fts, entry };
}

/**
 * Send a chat message and get an AI response grounded in the knowledge graph.
 *
 * @param messages - Conversation history (user/assistant messages)
 * @param options - Repo name, LLM config overrides
 */
export async function chat(
  messages: ChatMessage[],
  options?: { repo?: string; llm?: Partial<LLMConfig> },
): Promise<ChatResponse> {
  const session = createChatSession(options?.repo);

  try {
    // Extract the latest user query for retrieval
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const query = lastUserMsg?.content ?? '';

    // Retrieve relevant context from knowledge graph
    const { sources, context: retrievalContext } = retrieveContext(session.fts, query);

    // Build augmented messages
    const augmentedMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: `Retrieved code context:\n${retrievalContext}` },
      ...messages,
    ];

    // Call LLM
    const response = await callLLM(augmentedMessages, options?.llm);

    return {
      content: response.content,
      sources,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
    };
  } finally {
    session.store.close();
    session.fts.close();
  }
}
