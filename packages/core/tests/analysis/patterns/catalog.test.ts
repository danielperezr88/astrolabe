/**
 * Tests for the design pattern catalog (#872).
 *
 * Validates catalog structure, completeness, per-language coverage,
 * and lookup utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  PATTERN_CATALOG,
  getPatternsForLanguage,
  getPatternById,
} from '../../../src/analysis/patterns/index.js';
import type { PatternDefinition, PatternSignature } from '../../../src/analysis/patterns/index.js';

describe('Pattern Catalog', () => {
  it('has at least 15 pattern definitions', () => {
    expect(PATTERN_CATALOG.length).toBeGreaterThanOrEqual(15);
  });

  it('every pattern has a unique id', () => {
    const ids = PATTERN_CATALOG.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('every pattern has required fields', () => {
    for (const p of PATTERN_CATALOG) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.category).toBeTruthy();
      expect(p.intent).toBeTruthy();
      expect(Object.keys(p.languages).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every pattern has valid tree-sitter queries', () => {
    for (const p of PATTERN_CATALOG) {
      for (const [lang, signatures] of Object.entries(p.languages)) {
        expect(signatures).toBeTruthy();
        expect(signatures!.length).toBeGreaterThanOrEqual(1);
        for (const sig of signatures!) {
          expect(sig.query).toBeTruthy();
          expect(typeof sig.query).toBe('string');
          // Every query must be a valid S-expression (starts with '(')
          expect(sig.query.startsWith('(')).toBe(true);
        }
      }
    }
  });

  it('has GoF creational patterns', () => {
    const creational = PATTERN_CATALOG.filter(
      (p) => p.category === 'gof-creational',
    );
    expect(creational.length).toBeGreaterThanOrEqual(3);
    const names = creational.map((p) => p.name);
    expect(names).toContain('Singleton');
    expect(names).toContain('Factory Method');
    expect(names).toContain('Builder');
  });

  it('has GoF structural patterns', () => {
    const structural = PATTERN_CATALOG.filter(
      (p) => p.category === 'gof-structural',
    );
    expect(structural.length).toBeGreaterThanOrEqual(2);
  });

  it('has GoF behavioral patterns', () => {
    const behavioral = PATTERN_CATALOG.filter(
      (p) => p.category === 'gof-behavioral',
    );
    expect(behavioral.length).toBeGreaterThanOrEqual(2);
  });

  it('TypeScript has pattern coverage', () => {
    const tsPatterns = getPatternsForLanguage('typescript');
    expect(tsPatterns.length).toBeGreaterThanOrEqual(5);
  });

  it('Python has pattern coverage', () => {
    const pyPatterns = getPatternsForLanguage('python');
    expect(pyPatterns.length).toBeGreaterThanOrEqual(3);
  });

  it('Java has pattern coverage', () => {
    const javaPatterns = getPatternsForLanguage('java');
    expect(javaPatterns.length).toBeGreaterThanOrEqual(3);
  });

  it('C# has pattern coverage', () => {
    const csPatterns = getPatternsForLanguage('csharp');
    expect(csPatterns.length).toBeGreaterThanOrEqual(3);
  });
});

describe('getPatternsForLanguage', () => {
  it('returns empty for language with no patterns', () => {
    const result = getPatternsForLanguage('protobuf');
    expect(result).toEqual([]);
  });

  it('returns only patterns with signatures for the given language', () => {
    const tsPatterns = getPatternsForLanguage('typescript');
    for (const p of tsPatterns) {
      expect(p.languages.typescript).toBeTruthy();
      expect(p.languages.typescript!.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('includes idiom patterns for their respective languages', () => {
    const goPatterns = getPatternsForLanguage('go');
    const rustPatterns = getPatternsForLanguage('rust');
    // At least one idiom per language (if implemented)
    // Go goroutines and Rust traits are language-specific
    if (goPatterns.length > 0) {
      const goIdiom = goPatterns.find((p) => p.id.includes('go'));
      expect(goIdiom).toBeTruthy();
    }
    if (rustPatterns.length > 0) {
      const rustIdiom = rustPatterns.find((p) => p.id.includes('rust'));
      expect(rustIdiom).toBeTruthy();
    }
  });
});

describe('getPatternById', () => {
  it('finds existing pattern by id', () => {
    const singleton = getPatternById('gof-singleton');
    expect(singleton).toBeTruthy();
    expect(singleton!.name).toBe('Singleton');
  });

  it('returns undefined for unknown id', () => {
    const result = getPatternById('nonexistent-pattern');
    expect(result).toBeUndefined();
  });

  it('every pattern in catalog is findable by id', () => {
    for (const p of PATTERN_CATALOG) {
      const found = getPatternById(p.id);
      expect(found).toBe(p);
    }
  });
});
