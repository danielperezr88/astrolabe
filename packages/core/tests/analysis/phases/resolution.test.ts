/**
 * Tests for the Resolution pipeline phase.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { scanPhase } from '../../../src/analysis/phases/scan.js';
import { structurePhase } from '../../../src/analysis/phases/structure.js';
import { parseEmitPhase } from '../../../src/analysis/phases/parse-emit.js';
import { resolutionPhase } from '../../../src/analysis/phases/resolution.js';
import type { ResolutionOutput } from '../../../src/analysis/phases/resolution.js';
import { createPhaseContext, runPipeline, getPhaseOutput } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';
import { initParser } from '../../../src/analysis/parser.js';

let testDir: string;

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'astrolabe-resolution-'));
  await initParser();
}, 30000);

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeRepo(fixtures: Record<string, string>): string {
  const tmp = mkdtempSync(join(testDir, 'repo-'));
  for (const [relPath, content] of Object.entries(fixtures)) {
    const fullPath = join(tmp, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return tmp;
}

describe('Resolution Phase', () => {
  describe('cross-file USES edges', () => {
    it('resolves named import to target symbol across files', async () => {
      const repo = makeRepo({
        'src/utils.ts': `
export function helper(): string {
  return 'ok';
}

export function format(x: string): string {
  return x.toUpperCase();
}
        `.trim(),
        'src/app.ts': `
import { helper, format } from './utils';

export function main(): string {
  return format(helper());
}
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase, resolutionPhase], context);

      const out = getPhaseOutput<ResolutionOutput>(context, 'resolution');
      expect(out.edgeCount).toBeGreaterThanOrEqual(2); // At least USES for helper, format
      expect(out.bindingCount).toBeGreaterThanOrEqual(2);

      // Verify USES edges exist
      const usesEdges = Array.from(graph.iterRelationshipsByType('USES'));
      expect(usesEdges.length).toBeGreaterThanOrEqual(2);

      // Verify target nodes exist (find by name, not hardcoded ID)
      const helperNode = Array.from(graph.iterNodes()).find(
        (n) => n.properties.name === 'helper' && n.properties.filePath === 'src/utils.ts'
      );
      expect(helperNode).toBeDefined();
      const formatNode = Array.from(graph.iterNodes()).find(
        (n) => n.properties.name === 'format' && n.properties.filePath === 'src/utils.ts'
      );
      expect(formatNode).toBeDefined();

      rmSync(repo, { recursive: true, force: true });
    });

    it('resolves default import to target class', async () => {
      const repo = makeRepo({
        'src/animal.ts': `
export default class Animal {
  speak() { return '...'; }
}

export class Dog {
  bark() { return 'woof'; }
}
        `.trim(),
        'src/main.ts': `
import Animal from './animal';
import { Dog } from './animal';

export function handle(a: Animal) {
  const d = new Dog();
}
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase, resolutionPhase], context);

      const out = getPhaseOutput<ResolutionOutput>(context, 'resolution');
      expect(out.edgeCount).toBeGreaterThan(0);

      // Should have Import nodes
      const importCount = Array.from(graph.iterNodes())
        .filter((n) => n.label === 'Import').length;
      expect(importCount).toBeGreaterThanOrEqual(2);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  describe('EXTENDS edge handling', () => {
    it('does NOT create false EXTENDS edges from imports (#70)', async () => {
      const repo = makeRepo({
        'src/base.ts': `
export class Animal {
  name: string = '';
}

export class BaseService {
  doWork() {}
}
        `.trim(),
        'src/derived.ts': `
import { Animal } from './base';

export class Dog {
  woof() { return 'woof'; }
}
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase, resolutionPhase], context);

      // Verify NO false-positive EXTENDS edges were created (#70)
      const extendsEdges = Array.from(graph.iterRelationshipsByType('EXTENDS'));
      expect(extendsEdges).toHaveLength(0);

      // Verify USES edges were created for the imports
      const usesEdges = Array.from(graph.iterRelationshipsByType('USES'));
      expect(usesEdges.length).toBeGreaterThan(0);

      // Dog class should exist
      const dogNode = Array.from(graph.iterNodes()).find(
        (n) => n.label === 'Class' && n.properties.name === 'Dog'
      );
      expect(dogNode).toBeDefined();

      rmSync(repo, { recursive: true, force: true });
    });
  });

  describe('empty / edge cases', () => {
    it('handles repo with no imports', async () => {
      const repo = makeRepo({
        'src/standalone.ts': `
export function foo() { return 1; }
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase, resolutionPhase], context);

      const out = getPhaseOutput<ResolutionOutput>(context, 'resolution');
      expect(out.edgeCount).toBe(0);
      expect(out.bindingCount).toBe(0);

      rmSync(repo, { recursive: true, force: true });
    });

    it('handles import from non-existent file gracefully', async () => {
      const repo = makeRepo({
        'src/app.ts': `
import { something } from './nonexistent';

export function foo() {}
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase, resolutionPhase], context);

      const out = getPhaseOutput<ResolutionOutput>(context, 'resolution');
      // Graceful — no crash, just no edges
      expect(out.edgeCount).toBeGreaterThanOrEqual(0);

      rmSync(repo, { recursive: true, force: true });
    });

    it('handles namespace imports', async () => {
      const repo = makeRepo({
        'src/lib.ts': `
export function a() {}
export function b() {}
        `.trim(),
        'src/app.ts': `
import * as lib from './lib';
export function main() {
  lib.a();
  lib.b();
}
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase, resolutionPhase], context);

      const out = getPhaseOutput<ResolutionOutput>(context, 'resolution');
      expect(out.fileCount).toBeGreaterThan(0);

      rmSync(repo, { recursive: true, force: true });
    });
  });
});
