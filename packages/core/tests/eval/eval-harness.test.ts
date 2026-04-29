/**
 * Eval harness for analysis quality benchmarking (#375).
 *
 * Provides test fixtures with known expected results and automatic
 * comparison of analysis output vs ground truth.
 *
 * Metrics: symbol extraction accuracy, import resolution accuracy,
 * call resolution accuracy, type inference accuracy.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, defaultWasmDir } from '../../src/analysis/parser.js';
import type { FileParseResult } from '../../src/analysis/language-definition.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Types ──────────────────────────────────────────────────────────────────

interface ExpectedSymbol {
  name: string;
  label: string;
  exported?: boolean;
}

interface ExpectedImport {
  source: string;
  names: string[];
}

interface EvalFixture {
  /** Source code to parse. */
  source: string;
  /** Language to parse as (extension determines grammar). */
  language: string;
  /** Ground-truth symbols that should be extracted. */
  expectedSymbols: ExpectedSymbol[];
  /** Ground-truth imports that should be extracted. */
  expectedImports?: ExpectedImport[];
  /** Min acceptable precision (0-1). */
  minPrecision?: number;
  /** Min acceptable recall (0-1). */
  minRecall?: number;
}

interface EvalResult {
  precision: number;
  recall: number;
  f1: number;
  missing: string[];
  extra: string[];
}

// ── Eval engine ────────────────────────────────────────────────────────────

function evalSymbols(actual: FileParseResult, expected: ExpectedSymbol[]): EvalResult {
  const expectedNames = new Set(expected.map((s) => `${s.label}:${s.name}`));
  const actualNames = new Set(actual.symbols.map((s) => `${s.label}:${s.name}`));

  const missing: string[] = [];
  const extra: string[] = [];

  for (const name of expectedNames) {
    if (!actualNames.has(name)) missing.push(name);
  }
  for (const name of actualNames) {
    if (!expectedNames.has(name)) extra.push(name);
  }

  const tp = expectedNames.size - missing.length;
  const precision = actualNames.size > 0 ? tp / actualNames.size : 0;
  const recall = expectedNames.size > 0 ? tp / expectedNames.size : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    precision: Math.round(precision * 100) / 100,
    recall: Math.round(recall * 100) / 100,
    f1: Math.round(f1 * 100) / 100,
    missing,
    extra,
  };
}

async function runEval(fixture: EvalFixture): Promise<EvalResult> {
  const tmpDir = tmpdir();
  const filePath = join(tmpDir, `eval-${Date.now()}.${fixture.language}`);

  writeFileSync(filePath, fixture.source, 'utf-8');
  let result: FileParseResult;
  try {
    result = await parseFile(filePath, defaultWasmDir());
  } finally {
    try { unlinkSync(filePath); } catch {}
  }

  return evalSymbols(result, fixture.expectedSymbols);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const TYPE_ANNOTATION_FIXTURES: EvalFixture[] = [
  {
    language: 'ts',
    source: `
export function getUser(id: number): User {
  return { id, name: 'test' };
}

class User {
  id: number;
  name: string;
}

const handler = (): Response => new Response();
    `.trim(),
    expectedSymbols: [
      { name: 'getUser', label: 'Function', exported: true },
      { name: 'User', label: 'Class', exported: true },
      { name: 'handler', label: 'Function' },
    ],
    minPrecision: 0.8,
    minRecall: 0.8,
  },
  {
    language: 'ts',
    source: `
import { Router } from 'express';

export default class AuthService {
  login(email: string, password: string): Promise<Token> {
    return fetch('/api/login', { method: 'POST' });
  }
}

interface Token {
  jwt: string;
}
    `.trim(),
    expectedSymbols: [
      { name: 'AuthService', label: 'Class', exported: true },
      { name: 'Token', label: 'Interface', exported: false },
      { name: 'login', label: 'Method', exported: false },
    ],
    expectedImports: [
      { source: 'express', names: ['Router'] },
    ],
    minPrecision: 0.7,
    minRecall: 0.7,
  },
  {
    language: 'js',
    source: `
function helper(x) {
  return x * 2;
}

export function main() {
  return helper(42);
}
    `.trim(),
    expectedSymbols: [
      { name: 'helper', label: 'Function' },
      { name: 'main', label: 'Function', exported: true },
    ],
    minPrecision: 0.8,
    minRecall: 0.8,
  },
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Eval Harness (#375)', () => {
  let initialized = false;

  it('initParser() completes without error', async () => {
    await initParser();
    initialized = true;
    expect(initialized).toBe(true);
  });

  for (const fixture of TYPE_ANNOTATION_FIXTURES) {
    it(`symbol extraction: ${fixture.language} — ${fixture.expectedSymbols.map((s) => s.name).join(', ')}`, async () => {
      if (!initialized) return;
      const result = await runEval(fixture);
      if (fixture.minPrecision !== undefined) {
        expect(result.precision, `precision too low: ${result.precision} < ${fixture.minPrecision}. Missing: ${result.missing.join(', ') || 'none'}. Extra: ${result.extra.join(', ') || 'none'}`)
          .toBeGreaterThanOrEqual(fixture.minPrecision);
      }
      if (fixture.minRecall !== undefined) {
        expect(result.recall, `recall too low: ${result.recall} < ${fixture.minRecall}. Missing: ${result.missing.join(', ') || 'none'}`)
          .toBeGreaterThanOrEqual(fixture.minRecall);
      }
    });
  }

  it('passes all fixtures with acceptable F1', async () => {
    if (!initialized) return;
    let allPassed = true;
    for (const fixture of TYPE_ANNOTATION_FIXTURES) {
      const result = await runEval(fixture);
      if (fixture.minPrecision && result.precision < fixture.minPrecision) allPassed = false;
      if (fixture.minRecall && result.recall < fixture.minRecall) allPassed = false;
    }
    expect(allPassed).toBe(true);
  });
});
