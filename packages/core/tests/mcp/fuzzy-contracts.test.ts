/**
 * Tests for fuzzy contract matching via embedding similarity.
 *
 * Verifies cosine similarity calculation, fuzzy match detection,
 * threshold filtering, exact vs fuzzy differentiation, and
 * the full fuzzyMatchContracts async pipeline.
 */
import { describe, it, expect } from 'vitest';
import {
  cosineSimilarity,
  fuzzyMatchContracts,
} from '../../src/mcp/contracts.js';
import type { EmbeddingProvider } from '../../src/mcp/contracts.js';

// ── Mock embedding provider ────────────────────────────────────────────────

/** Create a mock embedding provider that returns pre-defined vectors. */
function mockProvider(vectors: Map<string, number[]>): EmbeddingProvider {
  return {
    async encodeAsync(text: string): Promise<number[]> {
      const vec = vectors.get(text);
      if (vec) return vec;
      // Deterministic pseudo-embedding based on text hash for unknown inputs
      const result: number[] = [];
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      }
      for (let i = 0; i < 8; i++) {
        result.push(Math.sin(hash + i * 1.7));
      }
      return result;
    },
  };
}

// ── Cosine Similarity Tests ────────────────────────────────────────────────

describe('cosineSimilarity (dense vectors)', () => {
  it('returns 1 for identical vectors', () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it('returns 0 for empty or mismatched-length vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('computes correct similarity for arbitrary vectors', () => {
    // a = [1, 2, 3], b = [4, 5, 6]
    // dot = 4+10+18 = 32, |a| = sqrt(14), |b| = sqrt(77)
    // sim = 32 / sqrt(14*77) = 32 / sqrt(1078) ≈ 0.9746
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const expected = 32 / Math.sqrt(14 * 77);
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 6);
  });

  it('handles zero vectors gracefully', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });
});

// ── Fuzzy Match Detection Tests ────────────────────────────────────────────

describe('fuzzyMatchContracts', () => {
  it('returns no matches when embeddings are dissimilar', async () => {
    // Orthogonal vectors → similarity ~0
    const vectors = new Map<string, number[]>([
      ['provider-a', [1, 0, 0, 0]],
      ['consumer-b', [0, 1, 0, 0]],
    ]);
    const provider = mockProvider(vectors);

    const results = await fuzzyMatchContracts(
      [{ id: 'provider-a', description: 'provider-a' }],
      [{ id: 'consumer-b', description: 'consumer-b' }],
      provider,
    );

    expect(results).toHaveLength(0);
  });

  it('returns fuzzy matches for semantically similar descriptions', async () => {
    // Same vector → similarity 1.0 → definitely above threshold 0.7
    const sharedVec = [0.5, 0.5, 0.5, 0.5];
    const vectors = new Map<string, number[]>([
      ['GET /api/users', sharedVec],
      ['fetch users list', sharedVec],
    ]);
    const provider = mockProvider(vectors);

    const results = await fuzzyMatchContracts(
      [{ id: 'GET /api/users', description: 'GET /api/users' }],
      [{ id: 'fetch users list', description: 'fetch users list' }],
      provider,
    );

    expect(results).toHaveLength(1);
    expect(results[0].matchType).toBe('fuzzy');
    expect(results[0].confidence).toBeGreaterThan(0);
    expect(results[0].reason).toContain('Embedding similarity');
  });

  it('respects the similarity threshold', async () => {
    // Vectors with 0.6 similarity (below default 0.7 threshold)
    // a = [1, 0], b = [0.6, 0.8] → cos = 0.6
    const vectors = new Map<string, number[]>([
      ['provider-low', [1, 0]],
      ['consumer-low', [0.6, 0.8]],
    ]);
    const provider = mockProvider(vectors);

    // With default threshold (0.7) → should NOT match
    const resultsDefault = await fuzzyMatchContracts(
      [{ id: 'provider-low', description: 'provider-low' }],
      [{ id: 'consumer-low', description: 'consumer-low' }],
      provider,
    );
    expect(resultsDefault).toHaveLength(0);

    // With lower threshold (0.5) → should match
    const resultsLower = await fuzzyMatchContracts(
      [{ id: 'provider-low', description: 'provider-low' }],
      [{ id: 'consumer-low', description: 'consumer-low' }],
      provider,
      0.5,
    );
    expect(resultsLower).toHaveLength(1);
  });

  it('returns empty for empty providers or consumers', async () => {
    const provider = mockProvider(new Map());

    const r1 = await fuzzyMatchContracts([], [{ id: 'a', description: 'a' }], provider);
    expect(r1).toHaveLength(0);

    const r2 = await fuzzyMatchContracts([{ id: 'a', description: 'a' }], [], provider);
    expect(r2).toHaveLength(0);

    const r3 = await fuzzyMatchContracts([], [], provider);
    expect(r3).toHaveLength(0);
  });

  it('differentiates exact from fuzzy matches by matchType', async () => {
    const vectors = new Map<string, number[]>([
      ['provider-x', [1, 0, 0]],
      ['consumer-y', [1, 0, 0]],
    ]);
    const provider = mockProvider(vectors);

    const results = await fuzzyMatchContracts(
      [{ id: 'provider-x', description: 'provider-x' }],
      [{ id: 'consumer-y', description: 'consumer-y' }],
      provider,
    );

    expect(results).toHaveLength(1);
    // Fuzzy matches always have matchType 'fuzzy', not 'exact'
    expect(results[0].matchType).toBe('fuzzy');
    // Confidence is scaled down (sim * 0.7), not raw similarity
    expect(results[0].confidence).toBeLessThan(1.0);
  });

  it('sorts results by confidence descending', async () => {
    const vectors = new Map<string, number[]>([
      // provider-1 matches consumer-high with sim ~0.95
      ['provider-1', [0.95, 0.31, 0]],
      ['consumer-high', [1, 0, 0]],
      // provider-1 matches consumer-low with sim ~0.71
      ['consumer-low', [0.71, 0.71, 0]],
    ]);
    const provider = mockProvider(vectors);

    const results = await fuzzyMatchContracts(
      [{ id: 'provider-1', description: 'provider-1' }],
      [
        { id: 'consumer-high', description: 'consumer-high' },
        { id: 'consumer-low', description: 'consumer-low' },
      ],
      provider,
      0.5,
    );

    expect(results.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].confidence).toBeLessThanOrEqual(results[i - 1].confidence);
    }
  });

  it('handles multiple providers and consumers with correct pairing', async () => {
    // Two providers, two consumers — perfect 1:1 match with distinct vectors
    const vec1 = [1, 0, 0, 0];
    const vec2 = [0, 1, 0, 0];

    const vectors = new Map<string, number[]>([
      ['GET /users', vec1],
      ['GET /orders', vec2],
      ['client-fetchUsers', vec1],
      ['client-fetchOrders', vec2],
    ]);
    const provider = mockProvider(vectors);

    const results = await fuzzyMatchContracts(
      [
        { id: 'GET /users', description: 'GET /users' },
        { id: 'GET /orders', description: 'GET /orders' },
      ],
      [
        { id: 'client-fetchUsers', description: 'client-fetchUsers' },
        { id: 'client-fetchOrders', description: 'client-fetchOrders' },
      ],
      provider,
    );

    // Should have 2 matches: users↔fetchUsers, orders↔fetchOrders
    // And no cross-matches because orthogonal vectors → sim 0
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.matchType === 'fuzzy')).toBe(true);
  });
});
