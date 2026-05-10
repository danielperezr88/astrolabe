/**
 * Tests for cross-file type propagation — RETURNS_TYPE and DECLARES_TYPE edges (#640).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { initParser } from '../../../src/analysis/parser.js';
import { crossFilePhase } from '../../../src/analysis/phases/cross-file.js';
import type { CrossFileOutput } from '../../../src/analysis/phases/cross-file.js';
import { resolutionPhase } from '../../../src/analysis/phases/resolution.js';
import { parseEmitPhase } from '../../../src/analysis/phases/parse-emit.js';
import { structurePhase } from '../../../src/analysis/phases/structure.js';
import { scanPhase } from '../../../src/analysis/phases/scan.js';
import { createPhaseContext, runPipeline, getPhaseOutput } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';

beforeAll(async () => {
  await initParser();
}, 30000);

function makeRepo(fixtures: Record<string, string>): string {
  const tmp = mkdtempSync(join(tmpdir(), 'astrolabe-cross-file-'));
  for (const [path, content] of Object.entries(fixtures)) {
    const fullPath = join(tmp, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, { encoding: 'utf-8' });
  }
  return tmp;
}

// ── returnType → RETURNS_TYPE edges ─────────────────────────────────────

describe('CrossFile Phase — returnType resolution', () => {
  it('resolves Function returnType to imported Class and emits RETURNS_TYPE edge', async () => {
    const repo = makeRepo({
      'types.ts': `
        export class User {
          name: string;
          email: string;
        }
      `,
      'api.ts': `
        import { User } from './types';
        export function getUser(): User {
          return { name: 'Alice', email: 'alice@example.com' };
        }
      `,
    });

    try {
      const graph = createKnowledgeGraph();

      // Scan
      const scanCtx = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase], scanCtx);

      // Structure → Parse/Emit → Resolution → CrossFile
      const ctx = createPhaseContext(repo, graph, () => {});
      ctx.state.set('output:scan', getPhaseOutput(scanCtx, 'scan'));
      ctx.state.set('skipWorkers', true);
      ctx.state.set('profile', false);

      await runPipeline([
        structurePhase,
        parseEmitPhase,
        resolutionPhase,
        crossFilePhase,
      ], ctx);

      // Assert RETURNS_TYPE edge exists
      const edges: string[] = [];
      for (const edge of graph.iterRelationships()) {
        edges.push(edge.type);
      }

      expect(edges).toContain('RETURNS_TYPE');

      // Verify the edge connects the right nodes
      for (const edge of graph.iterRelationships()) {
        if (edge.type === 'RETURNS_TYPE') {
          const source = graph.getNode(edge.sourceId);
          const target = graph.getNode(edge.targetId);
          expect(source).not.toBeNull();
          expect(target).not.toBeNull();
          expect(source!.label).toBe('Function');
          expect(source!.properties.name).toBe('getUser');
          expect(target!.label).toBe('Class');
          expect(target!.properties.name).toBe('User');
          expect(source!.properties.resolved_returnType).toBe('User');
          expect(edge.confidence).toBe(0.8);
        }
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('resolves Method returnType to imported Class and emits RETURNS_TYPE edge', async () => {
    const repo = makeRepo({
      'models.ts': `
        export class Product {
          id: number;
          name: string;
        }
      `,
      'service.ts': `
        import { Product } from './models';
        export class ProductService {
          getProduct(): Product {
            return { id: 1, name: 'Widget' };
          }
        }
      `,
    });

    try {
      const graph = createKnowledgeGraph();

      const scanCtx = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase], scanCtx);

      const ctx = createPhaseContext(repo, graph, () => {});
      ctx.state.set('output:scan', getPhaseOutput(scanCtx, 'scan'));
      ctx.state.set('skipWorkers', true);
      ctx.state.set('profile', false);

      await runPipeline([
        structurePhase,
        parseEmitPhase,
        resolutionPhase,
        crossFilePhase,
      ], ctx);

      const edges: string[] = [];
      for (const edge of graph.iterRelationships()) {
        edges.push(edge.type);
      }

      expect(edges).toContain('RETURNS_TYPE');

      // Verify edge connects Method to Class
      for (const edge of graph.iterRelationships()) {
        if (edge.type === 'RETURNS_TYPE') {
          const source = graph.getNode(edge.sourceId);
          const target = graph.getNode(edge.targetId);
          expect(source!.label).toBe('Method');
          expect(source!.properties.name).toBe('getProduct');
          expect(target!.label).toBe('Class');
          expect(target!.properties.name).toBe('Product');
        }
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('emits no RETURNS_TYPE edge when returnType does not match any imported type', async () => {
    const repo = makeRepo({
      'api.ts': `
        export function getData(): string {
          return 'hello';
        }
      `,
    });

    try {
      const graph = createKnowledgeGraph();

      const scanCtx = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase], scanCtx);

      const ctx = createPhaseContext(repo, graph, () => {});
      ctx.state.set('output:scan', getPhaseOutput(scanCtx, 'scan'));
      ctx.state.set('skipWorkers', true);
      ctx.state.set('profile', false);

      await runPipeline([
        structurePhase,
        parseEmitPhase,
        resolutionPhase,
        crossFilePhase,
      ], ctx);

      // string is not a tracked type — no RETURNS_TYPE edge
      for (const edge of graph.iterRelationships()) {
        expect(edge.type).not.toBe('RETURNS_TYPE');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // ── Import order (topological) ────────────────────────────────

  it('resolves returnType when dep types are collected transitively through import chain', async () => {
    const repo = makeRepo({
      'A.ts': `
        export class BaseConfig {
          debug: boolean;
        }
      `,
      'B.ts': `
        import { BaseConfig } from './A';
        export class ExtendedConfig extends BaseConfig {
          logLevel: string;
        }
      `,
      'C.ts': `
        import { ExtendedConfig } from './B';
        export function makeConfig(): ExtendedConfig {
          return { debug: true, logLevel: 'info' };
        }
      `,
    });

    try {
      const graph = createKnowledgeGraph();

      const scanCtx = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase], scanCtx);

      const ctx = createPhaseContext(repo, graph, () => {});
      ctx.state.set('output:scan', getPhaseOutput(scanCtx, 'scan'));
      ctx.state.set('skipWorkers', true);
      ctx.state.set('profile', false);

      await runPipeline([
        structurePhase,
        parseEmitPhase,
        resolutionPhase,
        crossFilePhase,
      ], ctx);

      let hasReturnsType = false;
      for (const edge of graph.iterRelationships()) {
        if (edge.type === 'RETURNS_TYPE') {
          hasReturnsType = true;
          const source = graph.getNode(edge.sourceId);
          const target = graph.getNode(edge.targetId);
          expect(source!.properties.name).toBe('makeConfig');
          expect(target!.properties.name).toBe('ExtendedConfig');
          expect(target!.label).toBe('Class');
        }
      }
      expect(hasReturnsType).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
