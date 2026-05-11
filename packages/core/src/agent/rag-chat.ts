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
import { stripTrailingSep } from '@astrolabe-dev/shared';

// ── LLM Client ────────────────────────────────────────────────────────────

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** #767: LLM provider name for auto-configuration. */
  provider?: string;
}

const DEFAULT_LLM_CONFIG: LLMConfig = {
  apiKey: process.env.ASTROLABE_API_KEY || process.env.OPENAI_API_KEY || '',
  baseUrl: process.env.ASTROLABE_LLM_BASE_URL || 'https://api.openai.com/v1',
  model: process.env.ASTROLABE_MODEL || 'gpt-4o-mini',
  maxTokens: 4096,
  temperature: 0,
  provider: undefined, // #767
};

// ── Token Budget (#645) ──────────────────────────────────────────────────────

/** Rough estimate: ~4 chars per token for English text. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Context window sizes for common models (input tokens). #767: expanded beyond OpenAI. */
const MODEL_INPUT_LIMITS: Record<string, number> = {
  // OpenAI
  'gpt-4': 8192,
  'gpt-4-turbo': 128_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-3.5-turbo': 16_384,
  'gpt-3.5-turbo-16k': 16_384,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o1-pro': 200_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
  // Anthropic
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
  'claude-3.5-sonnet': 200_000,
  'claude-3.5-haiku': 200_000,
  'claude-4-sonnet': 200_000,
  'claude-4-opus': 200_000,
  // Google
  'gemini-1.5-pro': 1_000_000,
  'gemini-1.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  // MiniMax
  'minimax-m2.5': 1_000_000,
  // GLM
  'glm-4': 128_000,
};

// #767: Provider endpoint configuration for auto-URL and env-key resolution.
const PROVIDER_CONFIGS: Record<string, { baseUrl: string; envKey: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1/chat/completions', envKey: 'OPENAI_API_KEY' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1/messages', envKey: 'ANTHROPIC_API_KEY' },
  ollama: { baseUrl: 'http://localhost:11434/v1/chat/completions', envKey: '' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1/chat/completions', envKey: 'OPENROUTER_API_KEY' },
  azure: { baseUrl: '', envKey: 'AZURE_OPENAI_API_KEY' },
};

// #767: OpenAI reasoning models that omit max_tokens / temperature.
const REASONING_MODELS = new Set([
  'o1', 'o1-mini', 'o1-pro', 'o1-preview', 'o1-mini-preview',
  'o3', 'o3-mini',
  'o4-mini',
]);

/** #767: Check if a model is an OpenAI reasoning model. */
function isReasoningModel(model: string): boolean {
  if (REASONING_MODELS.has(model)) return true;
  for (const rm of REASONING_MODELS) {
    if (model.startsWith(rm + '-') || model.startsWith(rm + '.')) return true;
  }
  return false;
}

function getInputLimit(model: string): number {
  if (MODEL_INPUT_LIMITS[model]) return MODEL_INPUT_LIMITS[model];
  for (const [key, limit] of Object.entries(MODEL_INPUT_LIMITS)) {
    if (model.startsWith(key)) return limit;
  }
  return 8000;
}

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

  // #767: Resolve URL and API key from provider config when available.
  const providerCfg = cfg.provider ? PROVIDER_CONFIGS[cfg.provider] : undefined;
  const url = cfg.baseUrl
    ? `${stripTrailingSep(cfg.baseUrl)}/chat/completions`
    : providerCfg?.baseUrl || 'https://api.openai.com/v1/chat/completions';
  const apiKey = cfg.apiKey
    || (providerCfg?.envKey ? process.env[providerCfg.envKey] : '')
    || '';
  if (!apiKey) throw new Error('No API key configured. Set ASTROLABE_API_KEY, OPENAI_API_KEY, or provider-specific env variable.');

  // #767: Reasoning models omit max_tokens and temperature.
  const isReasoning = isReasoningModel(cfg.model);
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
  };
  if (!isReasoning) {
    body.max_tokens = cfg.maxTokens;
    body.temperature = cfg.temperature;
  }

  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
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

    // #645: Truncate conversation history to fit model's input token budget.
    // System prompts + retrieval context are always kept. User/assistant
    // messages are dropped oldest-first until total fits within the budget.
    const model = options?.llm?.model ?? DEFAULT_LLM_CONFIG.model;
    const completionBudget = options?.llm?.maxTokens ?? DEFAULT_LLM_CONFIG.maxTokens;
    const inputLimit = getInputLimit(model) - completionBudget;
    const systemTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(`Retrieved code context:\n${retrievalContext}`);
    let truncatedMessages: ChatMessage[] = [];
    let runningTokens = systemTokens;
    // Walk history newest-to-oldest, keeping messages that fit
    const reversedMessages = [...messages].reverse();
    for (const msg of reversedMessages) {
      const t = estimateTokens(msg.content);
      if (runningTokens + t <= inputLimit) {
        runningTokens += t;
        truncatedMessages.unshift(msg);
      } else {
        break; // budget exhausted — drop remaining older messages
      }
    }

    const truncatedAugmented: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: `Retrieved code context:\n${retrievalContext}` },
    ];
    if (truncatedMessages.length < messages.length) {
      truncatedAugmented.push({
        role: 'system',
        content: `[${messages.length - truncatedMessages.length} older messages truncated to fit context window]`,
      });
    }
    truncatedAugmented.push(...truncatedMessages);

    // Call LLM
    const response = await callLLM(truncatedAugmented, options?.llm);

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
