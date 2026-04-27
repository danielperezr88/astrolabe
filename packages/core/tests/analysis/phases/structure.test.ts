/**
 * Tests for the Structure pipeline phase.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { scanPhase } from '../../../src/analysis/phases/scan.js';
import { structurePhase } from '../../../src/analysis/phases/structure.js';
import type { ScanOutput } from '../../../src/analysis/phases/scan.js';
import type { StructureOutput } from '../../../src/analysis/phases/structure.js';
import { createPhaseContext, runPipeline, getPhaseOutput } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';

function makeRepo(fixtures: Record<string, string>): string {
  const tmp = mkdtempSync(join(tmpdir(), 'astrolabe-structure-'));
  for (const [path, content] of Object.entries(fixtures)) {
    const fullPath = join(tmp, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return tmp;
}

describe('Structure Phase', () => {
  describe('file and folder nodes', () => {
    it('creates File nodes for all scanned files', async () => {
      const repo = makeRepo({
        'src/index.ts': 'export const x = 1;',
        'src/utils/helper.ts': 'export function h() {}',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase], context);

      const fileNode = graph.getNode('file:src/index.ts');
      expect(fileNode).toBeDefined();
      expect(fileNode?.label).toBe('File');
      expect(fileNode?.properties.name).toBe('index.ts');

      const helperNode = graph.getNode('file:src/utils/helper.ts');
      expect(helperNode).toBeDefined();
      expect(helperNode?.label).toBe('File');
      expect(helperNode?.properties.name).toBe('helper.ts');

      rmSync(repo, { recursive: true, force: true });
    });

    it('creates Folder nodes for directories', async () => {
      const repo = makeRepo({
        'src/index.ts': 'x',
        'src/utils/deep/helper.ts': 'y',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase], context);

      expect(graph.getNode('folder:src')).toBeDefined();
      expect(graph.getNode('folder:src/utils')).toBeDefined();
      expect(graph.getNode('folder:src/utils/deep')).toBeDefined();

      rmSync(repo, { recursive: true, force: true });
    });
  });

  describe('CONTAINS edges', () => {
    it('creates CONTAINS edges from folder to files', async () => {
      const repo = makeRepo({
        'src/index.ts': 'x',
        'src/helper.ts': 'y',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase], context);

      const containsFiles = Array.from(
        graph.iterRelationshipsByType('CONTAINS'),
      ).filter((r) => r.sourceId === 'folder:src' && r.targetId.startsWith('file:'));

      expect(containsFiles).toHaveLength(2);

      rmSync(repo, { recursive: true, force: true });
    });

    it('creates CONTAINS edges between folders', async () => {
      const repo = makeRepo({
        'src/utils/helper.ts': 'x',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase], context);

      const parentEdge = Array.from(
        graph.iterRelationshipsByType('CONTAINS'),
      ).find((r) => r.sourceId === 'folder:src' && r.targetId === 'folder:src/utils');

      expect(parentEdge).toBeDefined();

      rmSync(repo, { recursive: true, force: true });
    });
  });

  describe('structure output', () => {
    it('reports correct counts', async () => {
      const repo = makeRepo({
        'src/a.ts': 'x',
        'src/b.ts': 'y',
        'src/sub/c.ts': 'z',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase], context);
      const out = getPhaseOutput<StructureOutput>(context, 'structure');

      expect(out.fileCount).toBe(3);
      expect(out.folderCount).toBe(2); // src, src/sub
      expect(out.maxDepth).toBe(2); // src/sub/c.ts has depth 2

      rmSync(repo, { recursive: true, force: true });
    });
  });

  describe('package detection', () => {
    it('detects npm package from package.json', async () => {
      const repo = makeRepo({
        'package.json': '{"name": "test-pkg"}',
        'src/index.ts': 'x',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase], context);
      const out = getPhaseOutput<StructureOutput>(context, 'structure');

      expect(out.packageCount).toBe(1);
      const pkgNode = Array.from(graph.iterNodes()).find(
        (n) => n.label === 'Package' && n.properties.filePath === '.'
      );
      expect(pkgNode).toBeDefined();
      expect(pkgNode?.label).toBe('Package');
      expect(pkgNode?.properties.packageType).toBe('npm');

      rmSync(repo, { recursive: true, force: true });
    });

    it('detects Cargo.toml as cargo package', async () => {
      const repo = makeRepo({
        'Cargo.toml': '[package]\nname = "test"',
        'src/main.rs': 'fn main() {}',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase], context);
      const out = getPhaseOutput<StructureOutput>(context, 'structure');

      expect(out.packageCount).toBe(1);
      const pkg = Array.from(graph.iterNodes()).find(
        (n) => n.label === 'Package' && n.properties.packageType === 'cargo'
      );
      expect(pkg?.properties.packageType).toBe('cargo');

      rmSync(repo, { recursive: true, force: true });
    });

    it('detects go.mod as Go module', async () => {
      const repo = makeRepo({
        'go.mod': 'module example.com/test',
        'main.go': 'package main',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase], context);
      const out = getPhaseOutput<StructureOutput>(context, 'structure');

      expect(out.packageCount).toBe(1);
      const pkg = Array.from(graph.iterNodes()).find(
        (n) => n.label === 'Package' && n.properties.packageType === 'gomod'
      );
      expect(pkg?.properties.packageType).toBe('gomod');

      rmSync(repo, { recursive: true, force: true });
    });

    it('detects Python packages (pyproject.toml and setup.py)', async () => {
      const repo = makeRepo({
        'pyproject.toml': '[project]\nname = "test"',
        'src/__init__.py': '',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase], context);
      const out = getPhaseOutput<StructureOutput>(context, 'structure');

      expect(out.packageCount).toBe(1);
      const pkg = Array.from(graph.iterNodes()).find(
        (n) => n.label === 'Package' && n.properties.packageType === 'python'
      );
      expect(pkg?.properties.packageType).toBe('python');

      rmSync(repo, { recursive: true, force: true });
    });

    it('handles repo with no package files', async () => {
      const repo = makeRepo({
        'src/index.ts': 'x',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase], context);
      const out = getPhaseOutput<StructureOutput>(context, 'structure');

      expect(out.packageCount).toBe(0);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  describe('empty scan', () => {
    it('handles empty scan output', async () => {
      const repo = makeRepo({});
      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      await runPipeline([scanPhase, structurePhase], context);
      const out = getPhaseOutput<StructureOutput>(context, 'structure');

      expect(out.fileCount).toBe(0);
      expect(out.folderCount).toBe(0);

      rmSync(repo, { recursive: true, force: true });
    });
  });
});
