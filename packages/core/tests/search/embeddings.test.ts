/**
 * Tests for TF-IDF embeddings and cosine similarity search.
 */

import { describe, it, expect } from 'vitest';
import { buildTfIdfIndex, searchTfIdf, cosineSimilarity } from '../../src/search/embeddings.js';

describe('TF-IDF Embeddings', () => {
  it('builds index from document texts', () => {
    const docs = [
      { nodeId: 'fn:a', text: 'function handles user authentication and login' },
      { nodeId: 'fn:b', text: 'function processes payment and billing' },
      { nodeId: 'fn:c', text: 'function searches database for user records' },
    ];

    const idx = buildTfIdfIndex(docs);
    expect(idx.vectors.size).toBe(3);
    expect(idx.vectors.get('fn:a')!.weights.size).toBeGreaterThan(0);
  });

  it('finds relevant documents via cosine similarity', () => {
    const docs = [
      { nodeId: 'fn:a', text: 'user authentication login handler' },
      { nodeId: 'fn:b', text: 'payment billing invoice processor' },
      { nodeId: 'fn:c', text: 'database search query index' },
    ];

    const idx = buildTfIdfIndex(docs);
    const results = searchTfIdf('user login authentication', idx, 10);

    expect(results.length).toBeGreaterThan(0);
    // fn:a should be the best match since it shares "user", "authentication", "login"
    expect(results[0].nodeId).toBe('fn:a');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('cosine similarities are in [0,1] range', () => {
    const a_val = new Map([['user', 0.5], ['login', 0.3]]);
    const b_val = new Map([['user', 0.4], ['payment', 0.6]]);

    const sim = cosineSimilarity(a_val, 1.0, b_val, 1.0);
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it('handles empty query', () => {
    const idx = buildTfIdfIndex([{ nodeId: 'fn:a', text: 'hello world' }]);
    const results = searchTfIdf('', idx);
    expect(results).toHaveLength(0);
  });

  it('handles empty document set', () => {
    const idx = buildTfIdfIndex([]);
    expect(idx.vectors.size).toBe(0);
  });
});
