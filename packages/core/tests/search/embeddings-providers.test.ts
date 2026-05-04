/**
 * Tests for embedding providers — TransformersEmbeddingProvider,
 * RemoteEmbeddingProvider, and provider factory (#371).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  TransformersEmbeddingProvider,
  RemoteEmbeddingProvider,
  createEmbeddingProvider,
  createTfIdfEmbeddingProvider,
  isTransformersAvailable,
} from '../../src/search/embeddings-store.js';
import { buildTfIdfIndex } from '../../src/search/embeddings.js';

// ── TransformersEmbeddingProvider tests ─────────────────────────────────────

describe('TransformersEmbeddingProvider (#371)', () => {
  it('constructs with default dimensions (384)', () => {
    const provider = new TransformersEmbeddingProvider();
    expect(provider.dimensions).toBe(384);
  });

  it('constructs with custom dimensions', () => {
    const provider = new TransformersEmbeddingProvider(768);
    expect(provider.dimensions).toBe(768);
  });

  it('sync encode throws for ML providers (#379)', () => {
    const provider = new TransformersEmbeddingProvider(384);
    expect(() => provider.encode('test function')).toThrow(
      'TransformersEmbeddingProvider.encode() is not supported',
    );
  });

  it('encodeAsync falls back to bag-of-words hash when pipeline unavailable', async () => {
    // Without actually initializing the transformers pipeline
    // (model download would be slow), we test the fallback path.
    const provider = new TransformersEmbeddingProvider(384);
    // Force the pipeline to remain null by not calling ensureReady()
    const vec = await provider.encodeAsync('test authentication function');
    expect(vec.length).toBe(384);
    // Fallback should produce non-zero normalized vector
    expect(vec.some((v) => v !== 0)).toBe(true);
    // Should be normalized (unit vector)
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  }, 15000);

  it('encodeAsync is deterministic for same input (fallback path)', async () => {
    const provider = new TransformersEmbeddingProvider(384);
    const vec1 = await provider.encodeAsync('hello world');
    const vec2 = await provider.encodeAsync('hello world');
    expect(vec1).toEqual(vec2);
  });

  it('encodeAsync produces different vectors for different inputs (fallback path)', async () => {
    const provider = new TransformersEmbeddingProvider(384);
    const vec1 = await provider.encodeAsync('authentication service');
    const vec2 = await provider.encodeAsync('database query optimizer');
    // Vectors should differ (cosine similarity < 1.0)
    let dot = 0;
    for (let i = 0; i < vec1.length; i++) dot += vec1[i] * vec2[i];
    expect(dot).toBeLessThan(1.0);
  });

  it('respects ASTROLABE_EMBEDDING_MODEL env var', () => {
    const orig = process.env.ASTROLABE_EMBEDDING_MODEL;
    process.env.ASTROLABE_EMBEDDING_MODEL = 'custom-model';
    try {
      const provider = new TransformersEmbeddingProvider();
      // Model name should include Xenova/ prefix for non-/-containing names
      expect((provider as any)._modelName).toBe('Xenova/custom-model');
    } finally {
      process.env.ASTROLABE_EMBEDDING_MODEL = orig;
    }
  });

  it('respects ASTROLABE_EMBEDDING_MODEL with explicit org prefix', () => {
    const orig = process.env.ASTROLABE_EMBEDDING_MODEL;
    process.env.ASTROLABE_EMBEDDING_MODEL = 'Snowflake/snowflake-arctic-embed-xs';
    try {
      const provider = new TransformersEmbeddingProvider();
      expect((provider as any)._modelName).toBe('Snowflake/snowflake-arctic-embed-xs');
    } finally {
      process.env.ASTROLABE_EMBEDDING_MODEL = orig;
    }
  });

  it('respects ASTROLABE_EMBEDDING_DIMS env var', () => {
    const orig = process.env.ASTROLABE_EMBEDDING_DIMS;
    process.env.ASTROLABE_EMBEDDING_DIMS = '512';
    try {
      const provider = new TransformersEmbeddingProvider();
      expect(provider.dimensions).toBe(512);
    } finally {
      process.env.ASTROLABE_EMBEDDING_DIMS = orig;
    }
  });

  it('handles invalid ASTROLABE_EMBEDDING_DIMS gracefully', () => {
    const orig = process.env.ASTROLABE_EMBEDDING_DIMS;
    process.env.ASTROLABE_EMBEDDING_DIMS = 'not_a_number';
    try {
      const provider = new TransformersEmbeddingProvider();
      expect(provider.dimensions).toBe(384); // falls back to default
    } finally {
      process.env.ASTROLABE_EMBEDDING_DIMS = orig;
    }
  });
});

// ── RemoteEmbeddingProvider tests ───────────────────────────────────────────

describe('RemoteEmbeddingProvider (#371)', () => {
  it('throws without ASTROLABE_EMBEDDING_URL', () => {
    const orig = process.env.ASTROLABE_EMBEDDING_URL;
    delete process.env.ASTROLABE_EMBEDDING_URL;
    try {
      expect(() => new RemoteEmbeddingProvider()).toThrow('ASTROLABE_EMBEDDING_URL');
    } finally {
      process.env.ASTROLABE_EMBEDDING_URL = orig;
    }
  });

  it('constructs with ASTROLABE_EMBEDDING_URL set', () => {
    const origUrl = process.env.ASTROLABE_EMBEDDING_URL;
    const origKey = process.env.ASTROLABE_EMBEDDING_API_KEY;
    const origDims = process.env.ASTROLABE_EMBEDDING_DIMS;
    const origModel = process.env.ASTROLABE_EMBEDDING_MODEL;
    process.env.ASTROLABE_EMBEDDING_URL = 'http://localhost:11434/v1';
    delete process.env.ASTROLABE_EMBEDDING_API_KEY;
    delete process.env.ASTROLABE_EMBEDDING_DIMS;
    delete process.env.ASTROLABE_EMBEDDING_MODEL;
    try {
      const provider = new RemoteEmbeddingProvider();
      expect(provider.dimensions).toBe(768); // default
      expect((provider as any)._url).toBe('http://localhost:11434/v1/embeddings');
      expect((provider as any)._model).toBe('snowflake-arctic-embed-xs');
    } finally {
      process.env.ASTROLABE_EMBEDDING_URL = origUrl;
      process.env.ASTROLABE_EMBEDDING_API_KEY = origKey;
      process.env.ASTROLABE_EMBEDDING_DIMS = origDims;
      if (origModel) process.env.ASTROLABE_EMBEDDING_MODEL = origModel;
      else delete process.env.ASTROLABE_EMBEDDING_MODEL;
    }
  });

  it('respects ASTROLABE_EMBEDDING_MODEL', () => {
    const origUrl = process.env.ASTROLABE_EMBEDDING_URL;
    const origModel = process.env.ASTROLABE_EMBEDDING_MODEL;
    process.env.ASTROLABE_EMBEDDING_URL = 'http://localhost:8080/v1';
    process.env.ASTROLABE_EMBEDDING_MODEL = 'BAAI/bge-large-en-v1.5';
    try {
      const provider = new RemoteEmbeddingProvider();
      expect((provider as any)._model).toBe('BAAI/bge-large-en-v1.5');
    } finally {
      process.env.ASTROLABE_EMBEDDING_URL = origUrl;
      process.env.ASTROLABE_EMBEDDING_MODEL = origModel;
    }
  });

  it('respects ASTROLABE_EMBEDDING_API_KEY', () => {
    const origUrl = process.env.ASTROLABE_EMBEDDING_URL;
    const origKey = process.env.ASTROLABE_EMBEDDING_API_KEY;
    process.env.ASTROLABE_EMBEDDING_URL = 'http://localhost:8080/v1';
    process.env.ASTROLABE_EMBEDDING_API_KEY = 'sk-test-key';
    try {
      const provider = new RemoteEmbeddingProvider();
      expect((provider as any)._apiKey).toBe('sk-test-key');
    } finally {
      process.env.ASTROLABE_EMBEDDING_URL = origUrl;
      process.env.ASTROLABE_EMBEDDING_API_KEY = origKey;
    }
  });

  it('respects ASTROLABE_EMBEDDING_DIMS', () => {
    const origUrl = process.env.ASTROLABE_EMBEDDING_URL;
    const origDims = process.env.ASTROLABE_EMBEDDING_DIMS;
    process.env.ASTROLABE_EMBEDDING_URL = 'http://localhost:8080/v1';
    process.env.ASTROLABE_EMBEDDING_DIMS = '1024';
    try {
      const provider = new RemoteEmbeddingProvider();
      expect(provider.dimensions).toBe(1024);
    } finally {
      process.env.ASTROLABE_EMBEDDING_URL = origUrl;
      process.env.ASTROLABE_EMBEDDING_DIMS = origDims;
    }
  });

  it('sync encode throws for remote provider (#379)', () => {
    const origUrl = process.env.ASTROLABE_EMBEDDING_URL;
    const origDims = process.env.ASTROLABE_EMBEDDING_DIMS;
    process.env.ASTROLABE_EMBEDDING_URL = 'http://localhost:8080/v1';
    delete process.env.ASTROLABE_EMBEDDING_DIMS;
    try {
      const provider = new RemoteEmbeddingProvider();
      expect(() => provider.encode('test')).toThrow(
        'RemoteEmbeddingProvider.encode() is not supported',
      );
    } finally {
      process.env.ASTROLABE_EMBEDDING_URL = origUrl;
      process.env.ASTROLABE_EMBEDDING_DIMS = origDims;
    }
  });

  it('strips trailing slash from URL', () => {
    const origUrl = process.env.ASTROLABE_EMBEDDING_URL;
    process.env.ASTROLABE_EMBEDDING_URL = 'http://localhost:11434/v1/';
    try {
      const provider = new RemoteEmbeddingProvider();
      expect((provider as any)._url).toBe('http://localhost:11434/v1/embeddings');
    } finally {
      process.env.ASTROLABE_EMBEDDING_URL = origUrl;
    }
  });
});

// ── Provider factory tests ──────────────────────────────────────────────────

describe('createEmbeddingProvider factory (#371)', () => {
  it('returns TF-IDF provider when tfidfIndex provided and no env vars', () => {
    const index = buildTfIdfIndex([
      { nodeId: 'fn:a', text: 'user authentication login' },
    ]);
    const provider = createEmbeddingProvider('tfidf', index);
    expect(provider.dimensions).toBeGreaterThan(0);
    const vec = provider.encode('user');
    expect(vec.some((v) => v > 0)).toBe(true);
  });

  it('returns TransformersEmbeddingProvider for explicit transformers type', () => {
    const provider = createEmbeddingProvider('transformers');
    expect(provider).toBeInstanceOf(TransformersEmbeddingProvider);
  });

  it('returns RemoteEmbeddingProvider when URL env var is set', () => {
    const orig = process.env.ASTROLABE_EMBEDDING_URL;
    process.env.ASTROLABE_EMBEDDING_URL = 'http://localhost:8080/v1';
    try {
      const provider = createEmbeddingProvider('auto');
      expect(provider).toBeInstanceOf(RemoteEmbeddingProvider);
    } finally {
      process.env.ASTROLABE_EMBEDDING_URL = orig;
    }
  });

  it('returns TransformersEmbeddingProvider for auto when no URL set', () => {
    const orig = process.env.ASTROLABE_EMBEDDING_URL;
    delete process.env.ASTROLABE_EMBEDDING_URL;
    try {
      const provider = createEmbeddingProvider('auto');
      expect(provider).toBeInstanceOf(TransformersEmbeddingProvider);
    } finally {
      process.env.ASTROLABE_EMBEDDING_URL = orig;
    }
  });

  it('returns fallback 384D provider when auto and no index', () => {
    const orig = process.env.ASTROLABE_EMBEDDING_URL;
    delete process.env.ASTROLABE_EMBEDDING_URL;
    try {
      const provider = createEmbeddingProvider('tfidf'); // tfidf without index
      expect(provider.dimensions).toBe(384);
    } finally {
      process.env.ASTROLABE_EMBEDDING_URL = orig;
    }
  });
});

// ── isTransformersAvailable tests ───────────────────────────────────────────

describe('isTransformersAvailable (#371)', () => {
  it('returns true when @huggingface/transformers is installed', async () => {
    const available = await isTransformersAvailable();
    // We installed the package, so it should be available
    expect(available).toBe(true);
  });
});
