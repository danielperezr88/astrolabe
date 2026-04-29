/**
 * Tests for the Scan pipeline phase.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { scanPhase } from '../../../src/analysis/phases/scan.js';
import type { ScanOutput } from '../../../src/analysis/phases/scan.js';
import { createPhaseContext, runPipeline } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';

function makeRepo(fixtures: Record<string, string>, ignoreContent?: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'astrolabe-scan-'));
  for (const [path, content] of Object.entries(fixtures)) {
    const fullPath = join(tmp, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  if (ignoreContent) {
    writeFileSync(join(tmp, '.astrolabeignore'), ignoreContent);
  }
  return tmp;
}

describe('Scan Phase', () => {
  describe('file discovery', () => {
    it('discovers all source files recursively', async () => {
      const repo = makeRepo({
        'src/index.ts': 'export const x = 1;',
        'src/utils/helpers.js': 'function foo() {}',
        'tests/test.py': 'def test(): pass',
        'README.md': '# hello',
        'package.json': '{}',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      const output = await runPipeline([scanPhase], context);
      const scanOut = output[0] as ScanOutput;

      expect(scanOut.files).toHaveLength(5);
      const paths = scanOut.files.map((f) => f.path).sort();
      expect(paths).toContain('src/index.ts');
      expect(paths).toContain('src/utils/helpers.js');
      expect(paths).toContain('tests/test.py');
      expect(paths).toContain('README.md');
      expect(paths).toContain('package.json');

      rmSync(repo, { recursive: true, force: true });
    });

    it('detects languages by extension', async () => {
      const repo = makeRepo({
        'src/app.ts': 'let x = 1;',
        'src/lib.js': 'var y = 2;',
        'src/main.py': 'print(1)',
        'src/data.txt': 'hello',
        'src/nothing': 'no extension',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      const output = await runPipeline([scanPhase], context);
      const scanOut = output[0] as ScanOutput;

      const tsFile = scanOut.files.find((f) => f.path === 'src/app.ts')!;
      expect(tsFile.language).toBe('typescript');

      const jsFile = scanOut.files.find((f) => f.path === 'src/lib.js')!;
      expect(jsFile.language).toBe('javascript');

      const pyFile = scanOut.files.find((f) => f.path === 'src/main.py')!;
      expect(pyFile.language).toBe('python');

      const txtFile = scanOut.files.find((f) => f.path === 'src/data.txt')!;
      expect(txtFile.language).toBeNull();

      // Files with no extension should be excluded (not in allowed extension list)
      const noExt = scanOut.files.find((f) => f.path === 'src/nothing');
      expect(noExt).toBeUndefined();

      rmSync(repo, { recursive: true, force: true });
    });

    it('computes correct SHA256 hashes', async () => {
      const content = 'console.log("hello world");';
      const repo = makeRepo({ 'src/hello.js': content });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      const output = await runPipeline([scanPhase], context);
      const scanOut = output[0] as ScanOutput;

      const file = scanOut.files[0]!;
      expect(file.hash).toHaveLength(64);
      expect(typeof file.hash).toBe('string');
      // Same content should produce same hash on re-run
      const output2 = await runPipeline([scanPhase], createPhaseContext(repo, createKnowledgeGraph(), () => {}));
      const scanOut2 = output2[0] as ScanOutput;
      expect(scanOut2.files[0].hash).toBe(file.hash);

      rmSync(repo, { recursive: true, force: true });
    });

    it('handles empty directories gracefully', async () => {
      const repo = makeRepo({});
      mkdirSync(join(repo, 'empty_dir'), { recursive: true });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      const output = await runPipeline([scanPhase], context);
      const scanOut = output[0] as ScanOutput;

      expect(scanOut.files).toHaveLength(0);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  describe('.astrolabeignore', () => {
    it('respects .astrolabeignore patterns', async () => {
      const repo = makeRepo({
        'src/index.ts': 'x',
        'dist/index.js': 'x',
        'node_modules/lodash/index.js': 'x',
        'README.md': 'x',
      }, 'dist/\nnode_modules/\n*.md');

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      const output = await runPipeline([scanPhase], context);
      const scanOut = output[0] as ScanOutput;

      const paths = scanOut.files.map((f) => f.path);
      expect(paths).toContain('src/index.ts');
      expect(paths).not.toContain('dist/index.js');
      expect(paths).not.toContain('node_modules/lodash/index.js');
      expect(paths).not.toContain('README.md');

      rmSync(repo, { recursive: true, force: true });
    });

    it('gives files the correct size', async () => {
      const repo = makeRepo({
        'src/one.ts': 'abc',
        'src/two.ts': 'abcdefghij',
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      const output = await runPipeline([scanPhase], context);
      const scanOut = output[0] as ScanOutput;

      const one = scanOut.files.find((f) => f.path === 'src/one.ts')!;
      const two = scanOut.files.find((f) => f.path === 'src/two.ts')!;
      expect(one.size).toBe(3);
      expect(two.size).toBe(10);

      rmSync(repo, { recursive: true, force: true });
    });

    it('skips files larger than configured max file size (#373)', async () => {
      const smallContent = 'a'.repeat(100);
      const largeContent = 'a'.repeat(2000); // 2KB — above a 1KB limit
      const repo = makeRepo({
        'src/small.ts': smallContent,
        'src/large.ts': largeContent,
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      // Override max to 1KB (1 * 1024) — large.ts is 2000 bytes, should be skipped
      context.state.set('options:maxFileSize', 1);
      const output = await runPipeline([scanPhase], context);
      const scanOut = output[0] as ScanOutput;

      expect(scanOut.files).toHaveLength(1);
      expect(scanOut.files[0].path).toBe('src/small.ts');

      rmSync(repo, { recursive: true, force: true });
    });

    it('respects ASTROLABE_MAX_FILE_SIZE env var override (#373)', async () => {
      const smallContent = 'a'.repeat(100);
      const largeContent = 'a'.repeat(5000); // 5KB
      const repo = makeRepo({
        'src/small.ts': smallContent,
        'src/large.ts': largeContent,
      });

      process.env.ASTROLABE_MAX_FILE_SIZE = '2'; // 2KB threshold
      try {
        const graph = createKnowledgeGraph();
        const context = createPhaseContext(repo, graph, () => {});
        const output = await runPipeline([scanPhase], context);
        const scanOut = output[0] as ScanOutput;

        // large.ts is 5000 bytes > 2KB, should be skipped
        expect(scanOut.files).toHaveLength(1);
        expect(scanOut.files[0].path).toBe('src/small.ts');
      } finally {
        delete process.env.ASTROLABE_MAX_FILE_SIZE;
      }

      rmSync(repo, { recursive: true, force: true });
    });
  });
});
