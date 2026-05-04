export { createFtsSearch } from './fts.js';
export type { FtsSearch, SearchResult } from './fts.js';
export { buildTfIdfIndex, searchTfIdf, cosineSimilarity } from './embeddings.js';
export type { TfIdfIndex, TfIdfVector, SimilarityResult } from './embeddings.js';
export {
  EmbeddingStore,
  createTfIdfEmbeddingProvider,
  TransformersEmbeddingProvider,
  RemoteEmbeddingProvider,
  createEmbeddingProvider,
  isTransformersAvailable,
} from './embeddings-store.js';
export type { EmbeddingEntry, EmbeddingProvider, EmbeddingProviderType } from './embeddings-store.js';
export { hybridSearch, searchVector, cosineSimilarityVec } from './hybrid-search.js';
export type { HybridResult, HybridSearchOptions } from './hybrid-search.js';
