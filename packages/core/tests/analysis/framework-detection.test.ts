/**
 * Tests for framework detection (#251).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FrameworkInfo } from '../../src/analysis/framework-detection.js';

const { detectFrameworks } = await vi.importActual<typeof import('../../src/analysis/framework-detection.js')>('../../src/analysis/framework-detection.js');
const { createKnowledgeGraph } = await vi.importActual<typeof import('../../src/core/graph.js')>('../../src/core/graph.js');

let _content: string | null = null;

vi.mock('node:fs', () => ({
  existsSync: (path: string) => path.includes('package.json'),
  readFileSync: () => _content ?? '{}',
}));

function setMock(content: string | null) { _content = content; }

describe('Framework Detection', () => {
  beforeEach(() => { _content = null; vi.clearAllMocks(); });

  it('detects Next.js from package.json', () => {
    setMock(JSON.stringify({ dependencies: { next: '14.0.0' } }));
    const r = detectFrameworks('/fake/repo', createKnowledgeGraph());
    expect(r.some((f: FrameworkInfo) => f.name === 'next')).toBe(true);
  });

  it('detects Express from package.json', () => {
    setMock(JSON.stringify({ dependencies: { express: '4.18.0' } }));
    const r = detectFrameworks('/fake/repo', createKnowledgeGraph());
    expect(r.some((f: FrameworkInfo) => f.name === 'express')).toBe(true);
  });

  it('detects Prisma ORM from package.json', () => {
    setMock(JSON.stringify({ dependencies: { prisma: '5.0.0' } }));
    const r = detectFrameworks('/fake/repo', createKnowledgeGraph());
    expect(r.some((f: FrameworkInfo) => f.name === 'prisma')).toBe(true);
  });

  it('returns empty when no known deps', () => {
    setMock(JSON.stringify({ dependencies: { lodash: '4.0.0' } }));
    const r = detectFrameworks('/fake/repo', createKnowledgeGraph());
    expect(r).toEqual([]);
  });

  it('creates Framework nodes in graph', () => {
    setMock(JSON.stringify({ dependencies: { express: '4.18.0' } }));
    const g = createKnowledgeGraph();
    g.addNode({ id: 'p:root', label: 'Package', properties: { name: 'root', filePath: '.' } });
    detectFrameworks('/fake/repo', g);
    const fws = Array.from(g.iterNodes()).filter((n) => n.label === 'Framework');
    expect(fws.length).toBe(1);
    expect(fws[0]?.properties.name).toBe('express');
  });

  it('returns empty when no config at all', () => {
    setMock(null as any);
    vi.resetModules();
    const r = detectFrameworks('/fake/repo', createKnowledgeGraph());
    expect(r).toEqual([]);
  });
});
