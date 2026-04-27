/**
 * Tests for the Parse-Emit pipeline phase.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanPhase } from '../../../src/analysis/phases/scan.js';
import { structurePhase } from '../../../src/analysis/phases/structure.js';
import { parseEmitPhase } from '../../../src/analysis/phases/parse-emit.js';
import type { ParseEmitOutput } from '../../../src/analysis/phases/parse-emit.js';
import { createPhaseContext, runPipeline, getPhaseOutput } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';
import { initParser, resetParser } from '../../../src/analysis/parser.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

let testDir: string;

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'astrolabe-parse-emit-'));
  await initParser();
}, 30000);

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeRepo(fixtures: Record<string, string>): string {
  const tmp = mkdtempSync(join(testDir, 'repo-'));
  for (const [relPath, content] of Object.entries(fixtures)) {
    const fullPath = join(tmp, relPath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf('\\'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }
  return tmp;
}

describe('Parse-Emit Phase', () => {
  describe('TypeScript symbol nodes', () => {
    it('emits Function and Class nodes from TypeScript files', async () => {
      const repo = makeRepo({
        'src/app.ts': `
export class UserService {
  constructor(private db: Database) {}

  async findUser(id: string): Promise<User> {
    return this.db.find(id);
  }
}

export function createUser(data: UserData): User {
  return new User(data);
}
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase], context);

      const out = getPhaseOutput<ParseEmitOutput>(context, 'parse-emit');

      expect(out.symbolCount).toBeGreaterThanOrEqual(3); // Class, method, function
      expect(out.fileCount).toBe(1);
      expect(out.errorCount).toBe(0);

      // Class node
      const classNode = graph.getNode('Class:src/app.ts:UserService');
      expect(classNode).toBeDefined();
      expect(classNode?.label).toBe('Class');
      expect(classNode?.properties.name).toBe('UserService');
      expect(classNode?.properties.isExported).toBe(true);

      // Function node
      const funcNode = graph.getNode('Function:src/app.ts:createUser');
      expect(funcNode).toBeDefined();
      expect(funcNode?.label).toBe('Function');
      expect(funcNode?.properties.isExported).toBe(true);

      rmSync(repo, { recursive: true, force: true });
    });

    it('emits Interface and Enum nodes', async () => {
      const repo = makeRepo({
        'src/types.ts': `
export interface User {
  id: string;
  name: string;
}

export enum Status {
  Active = 'active',
  Inactive = 'inactive',
}

export type ID = string;
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase], context);

      const iface = graph.getNode('Interface:src/types.ts:User');
      expect(iface).toBeDefined();
      expect(iface?.label).toBe('Interface');

      const enumNode = graph.getNode('Enum:src/types.ts:Status');
      expect(enumNode).toBeDefined();
      expect(enumNode?.label).toBe('Enum');

      const typeAlias = graph.getNode('TypeAlias:src/types.ts:ID');
      expect(typeAlias).toBeDefined();

      rmSync(repo, { recursive: true, force: true });
    });

    it('handles non-exported symbols', async () => {
      const repo = makeRepo({
        'src/internal.ts': `
const helper = () => {};

function doWork() {
  return helper();
}
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase], context);

      const funcNode = graph.getNode('Function:src/internal.ts:doWork');
      expect(funcNode).toBeDefined();
      expect(funcNode?.properties.isExported).toBe(false);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  describe('JavaScript files', () => {
    it('parses JS files with import statements', async () => {
      const repo = makeRepo({
        'src/index.js': `
import { foo } from './utils';
foo();
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase], context);

      const out = getPhaseOutput<ParseEmitOutput>(context, 'parse-emit');
      expect(out.importCount).toBeGreaterThan(0);

      // Should have Import node
      const importNodes = Array.from(graph.iterNodes())
        .filter((n) => n.label === 'Import')
        .map((n) => n.id);
      expect(importNodes.length).toBeGreaterThan(0);

      // Should have IMPORTS edge
      const impEdges = Array.from(graph.iterRelationshipsByType('IMPORTS'));
      expect(impEdges.length).toBeGreaterThan(0);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  describe('Python files', () => {
    it('parses Python class and function definitions', async () => {
      const repo = makeRepo({
        'src/main.py': `
class Calculator:
    def add(self, a, b):
        return a + b

    def multiply(self, a, b):
        return a * b

def greet(name):
    print(f"Hello, {name}!")
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase], context);

      const out = getPhaseOutput<ParseEmitOutput>(context, 'parse-emit');
      expect(out.symbolCount).toBeGreaterThanOrEqual(3); // Class + 2 methods + function
      expect(out.errorCount).toBe(0);

      const classNode = graph.getNode('Class:src/main.py:Calculator');
      expect(classNode).toBeDefined();

      const funcNode = graph.getNode('Function:src/main.py:greet');
      expect(funcNode).toBeDefined();

      rmSync(repo, { recursive: true, force: true });
    });
  });

  describe('edge cases', () => {
    it('handles files with parse errors gracefully', async () => {
      const repo = makeRepo({
        'src/broken.ts': 'this is not valid typescript ^^^ {{{',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase], context);

      const out = getPhaseOutput<ParseEmitOutput>(context, 'parse-emit');
      expect(out.fileCount).toBe(1);
      expect(out.errorCount).toBe(0); // tree-sitter can parse almost anything
      // But the symbol/import count should be 0
      expect(out.symbolCount).toBe(0);

      rmSync(repo, { recursive: true, force: true });
    });

    it('skips non-parsable files', async () => {
      const repo = makeRepo({
        'README.md': '# Project',
        'src/index.ts': 'export function main() { return 1; }',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase], context);

      const out = getPhaseOutput<ParseEmitOutput>(context, 'parse-emit');
      expect(out.fileCount).toBe(1); // Only index.ts
      expect(out.symbolCount).toBe(1); // function main

      rmSync(repo, { recursive: true, force: true });
    });

    it('emits symbol counts per label', async () => {
      const repo = makeRepo({
        'src/app.ts': `
export class App {}
export class Config {}
export function init() {}
export const version = '1.0';
        `.trim(),
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase, parseEmitPhase], context);

      const out = getPhaseOutput<ParseEmitOutput>(context, 'parse-emit');
      expect(out.symbolCounts['Class']).toBe(2);
      expect(out.symbolCounts['Function']).toBe(1);

      rmSync(repo, { recursive: true, force: true });
    });
  });
});
