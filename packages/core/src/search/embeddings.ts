/**
 * Optional vector embeddings for semantic search.
 *
 * Placeholder for integration with embedding models (e.g., OpenAI,
 * local transformers) to enable similarity-based search beyond BM25.
 */
export function embedNode(_text: string): number[] {
  // Placeholder — returns zero vector of dimension 384 (MiniLM-L6-v2 size)
  return new Array(384).fill(0);
}

export function cosineSimilarity(_a: number[], _b: number[]): number {
  return 0; // Placeholder
}
