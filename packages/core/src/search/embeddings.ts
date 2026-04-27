/**
 * TF-IDF embedding generator for semantic search (#15).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface TfIdfVector {
  /** Map of term → TF-IDF weight */
  weights: Map<string, number>;
  /** Euclidean norm for cosine similarity */
  norm: number;
}

export interface SimilarityResult {
  nodeId: string;
  score: number;
  matchedTerms: string[];
}

// ── Text preprocessing ──────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

const STOP_WORDS = new Set([
  'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
  'in', 'with', 'to', 'for', 'of', 'from', 'by', 'as', 'be', 'this',
  'that', 'it', 'not', 'are', 'was', 'were', 'been', 'has', 'have',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'you', 'he', 'she', 'they', 'we',
  'i', 'me', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
]);

// ── TF-IDF computation ─────────────────────────────────────────────────────

/**
 * Build TF-IDF vectors for a set of documents.
 *
 * @param documents  Array of { nodeId, text } pairs.
 * @returns Map of nodeId → TF-IDF vector.
 */
export function buildTfIdfIndex(documents: { nodeId: string; text: string }[]): Map<string, TfIdfVector> {
  const N = documents.length;
  if (N === 0) return new Map();

  // Tokenize all documents
  const docTokens: Map<string, string[]> = new Map();
  for (const doc of documents) {
    docTokens.set(doc.nodeId, tokenize(doc.text));
  }

  // Compute document frequency (DF)
  const df = new Map<string, number>();
  for (const [, tokens] of docTokens) {
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        df.set(t, (df.get(t) ?? 0) + 1);
        seen.add(t);
      }
    }
  }

  // Compute TF-IDF vectors
  const index = new Map<string, TfIdfVector>();
  for (const doc of documents) {
    const tokens = docTokens.get(doc.nodeId)!;
    const weights = new Map<string, number>();
    let normSq = 0;

    // Term frequency (TF)
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    for (const [term, freq] of tf) {
      const idf = Math.log(N / ((df.get(term) ?? 1) + 1));
      const w = freq * idf;
      weights.set(term, w);
      normSq += w * w;
    }

    index.set(doc.nodeId, {
      weights,
      norm: Math.sqrt(normSq) || 1,
    });
  }

  return index;
}

/**
 * Compute cosine similarity between two TF-IDF vectors.
 */
export function cosineSimilarity(a: Map<string, number>, normA: number, b: Map<string, number>, normB: number): number {
  if (normA === 0 || normB === 0) return 0;
  let dot = 0;
  for (const [term, weight] of a) {
    dot += weight * (b.get(term) ?? 0);
  }
  return dot / (normA * normB);
}

/**
 * Search the TF-IDF index for documents similar to a query string.
 */
export function searchTfIdf(
  query: string,
  index: Map<string, TfIdfVector>,
  limit = 20,
): SimilarityResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const queryWeights = new Map<string, number>();
  let queryNormSq = 0;
  // Compute IDF only for query terms to avoid O(corpus×terms) (#186)
  const idfCache = new Map<string, number>();
  for (const t of new Set(queryTokens)) {
    let docsWithTerm = 0;
    for (const [, vec] of index) {
      if (vec.weights.has(t)) docsWithTerm++;
    }
    idfCache.set(t, Math.log((index.size + 1) / (docsWithTerm + 1)));
  }

  for (const t of queryTokens) {
    const tf = (queryWeights.get(t) ?? 0) + 1;
    const idf = idfCache.get(t) ?? Math.log((index.size + 1) / 1);
    const weight = tf * idf;
    queryWeights.set(t, weight);
  }
  for (const [, w] of queryWeights) {
    queryNormSq += w * w;
  }
  const queryNorm = Math.sqrt(queryNormSq) || 1;

  const results: SimilarityResult[] = [];
  for (const [nodeId, vec] of index) {
    const score = cosineSimilarity(queryWeights, queryNorm, vec.weights, vec.norm);
    if (score > 0) {
      const matchedTerms = Array.from(queryWeights.keys()).filter((t) => vec.weights.has(t));
      results.push({ nodeId, score, matchedTerms });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
