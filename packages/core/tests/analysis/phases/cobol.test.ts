/**
 * Tests for COBOL phase (#271) — regex-based program detection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledgeGraph } from '../../../src/core/graph.js';
import { createPhaseContext } from '../../../src/core/pipeline.js';
import { cobolPhase } from '../../../src/analysis/phases/cobol.js';

let testDir: string;

function makeContext(graph: any, filePaths: string[]) {
  const ctx = createPhaseContext(testDir, graph, () => {});
  ctx.state.set('output:scan', {
    files: filePaths.map((fp) => ({
      path: join(testDir, fp),
      hash: 'abc',
      ext: fp.split('.').pop() || '',
      size: 100,
      language: 'unknown' as any,
      extension: fp.split('.').pop() || '',
      absolutePath: join(testDir, fp),
    })),
    directoryCount: 1,
  });
  return ctx;
}

describe('COBOL Phase (#271)', () => {
  beforeAll(() => {
    testDir = join(tmpdir(), 'astrolabe-cobol-' + Date.now());
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('detects PROGRAM-ID in .cbl files', () => {
    writeFileSync(join(testDir, 'main.cbl'), `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. MainProgram.
       PROCEDURE DIVISION.
           DISPLAY 'Hello'.
           STOP RUN.
    `, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['main.cbl']);

    const result = cobolPhase.execute(ctx) as any;
    expect(result.programCount).toBe(1);

    // Verify node creation
    const nodeId = 'cobol:program:' + join(testDir, 'main.cbl') + ':MainProgram';
    const programNode = graph.getNode(nodeId);
    expect(programNode).toBeDefined();
    expect(programNode!.properties.name).toBe('MainProgram');
    expect(programNode!.properties.kind).toBe('COBOL Program');
  });

  it('detects CALL statements between programs', () => {
    writeFileSync(join(testDir, 'caller.cbl'), `
       PROGRAM-ID. CallerProg.
       PROCEDURE DIVISION.
           CALL 'CalledProg'.
           STOP RUN.
    `, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['caller.cbl']);

    const result = cobolPhase.execute(ctx) as any;
    expect(result.callCount).toBe(1);
    expect(result.programCount).toBe(1);
  });

  it('detects COPY statements', () => {
    writeFileSync(join(testDir, 'prog.cbl'), `
       PROGRAM-ID. MyProgram.
       DATA DIVISION.
       COPY 'common.cpy'.
       PROCEDURE DIVISION.
           STOP RUN.
    `, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['prog.cbl']);

    const result = cobolPhase.execute(ctx) as any;
    expect(result.copyCount).toBe(1);
  });

  it('uses filename when no PROGRAM-ID found', () => {
    writeFileSync(join(testDir, 'noid.cob'), `
       PROCEDURE DIVISION.
           DISPLAY 'No ID here'.
    `, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['noid.cob']);

    const result = cobolPhase.execute(ctx) as any;
    expect(result.programCount).toBe(1);

    const nodeId = 'cobol:program:' + join(testDir, 'noid.cob') + ':noid';
    const node = graph.getNode(nodeId);
    expect(node).toBeDefined();
  });

  it('skips non-COBOL files', () => {
    writeFileSync(join(testDir, 'main.ts'), `
      export function hello() { return 'world'; }
    `, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['main.ts']);

    const result = cobolPhase.execute(ctx) as any;
    expect(result.programCount).toBe(0);
    expect(result.callCount).toBe(0);
    expect(result.copyCount).toBe(0);
  });

  it('handles empty scan output', () => {
    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, []);

    const result = cobolPhase.execute(ctx) as any;
    expect(result.programCount).toBe(0);
  });
});
