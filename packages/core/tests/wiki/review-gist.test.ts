/**
 * Tests for wiki review mode and Gist publishing (#452).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateWiki } from '../../src/wiki/index.js';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import type { GraphNode, GraphRelationship } from '../../src/core/types.js';

// Auto-mock child_process — all functions become vi.fn()
vi.mock('node:child_process');

import { execSync, execFileSync } from 'node:child_process';

const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);

const TMP_BASE = join(__dirname, '__review_gist_tmp__');

function makeTempDir(name: string): string {
  const dir = join(TMP_BASE, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(): void {
  if (existsSync(TMP_BASE)) rmSync(TMP_BASE, { recursive: true, force: true });
}

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return { label: 'Function', properties: {}, ...overrides };
}

function makeRel(overrides: Partial<GraphRelationship> & { id: string; sourceId: string; targetId: string }): GraphRelationship {
  return { type: 'CALLS', confidence: 1.0, reason: 'test', ...overrides };
}

/** Build a graph with two communities (auth, db) for testing. */
function buildTestGraph() {
  const graph = createKnowledgeGraph();

  // Community nodes
  graph.addNode(makeNode({ id: 'comm:auth', label: 'Community', properties: { name: 'auth' } }));
  graph.addNode(makeNode({ id: 'comm:db', label: 'Community', properties: { name: 'db' } }));

  // Symbol nodes
  graph.addNode(makeNode({ id: 'fn:login', label: 'Function', properties: { name: 'login', sourceFile: 'src/auth.ts' } }));
  graph.addNode(makeNode({ id: 'fn:authenticate', label: 'Function', properties: { name: 'authenticate', sourceFile: 'src/auth.ts' } }));
  graph.addNode(makeNode({ id: 'fn:query', label: 'Function', properties: { name: 'query', sourceFile: 'src/db.ts' } }));
  graph.addNode(makeNode({ id: 'fn:connect', label: 'Function', properties: { name: 'connect', sourceFile: 'src/db.ts' } }));

  // MEMBER_OF relationships
  graph.addRelationship(makeRel({ id: 'rel:1', sourceId: 'fn:login', targetId: 'comm:auth', type: 'MEMBER_OF' }));
  graph.addRelationship(makeRel({ id: 'rel:2', sourceId: 'fn:authenticate', targetId: 'comm:auth', type: 'MEMBER_OF' }));
  graph.addRelationship(makeRel({ id: 'rel:3', sourceId: 'fn:query', targetId: 'comm:db', type: 'MEMBER_OF' }));
  graph.addRelationship(makeRel({ id: 'rel:4', sourceId: 'fn:connect', targetId: 'comm:db', type: 'MEMBER_OF' }));

  return graph;
}

describe('Wiki review mode and Gist publishing (#452)', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    // Default: simulate no git repo (git commands fail gracefully)
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('review mode writes module_tree.json and returns early', async () => {
    const repoPath = makeTempDir('review-early');
    const graph = buildTestGraph();

    const result = await generateWiki({
      repoPath,
      repoName: 'test-repo',
      graph,
      review: true,
    });

    expect(result.pageCount).toBe(0);
    expect(result.moduleCount).toBe(2);
    expect(result.overviewPath).toBe('');
    expect(result.htmlPath).toBe('');

    // module_tree.json was created
    const treePath = join(repoPath, '.astrolabe', 'wiki', 'module_tree.json');
    expect(existsSync(treePath)).toBe(true);
  });

  it('module_tree.json contains correct structure', async () => {
    const repoPath = makeTempDir('review-structure');
    const graph = buildTestGraph();

    await generateWiki({
      repoPath,
      repoName: 'test-repo',
      graph,
      review: true,
    });

    const treePath = join(repoPath, '.astrolabe', 'wiki', 'module_tree.json');
    const tree = JSON.parse(readFileSync(treePath, 'utf-8'));

    expect(tree.modules).toBeDefined();
    expect(tree.modules.auth).toBeDefined();
    expect(tree.modules.db).toBeDefined();
    expect(tree.modules.auth.symbols).toEqual(expect.arrayContaining(['login', 'authenticate']));
    expect(tree.modules.db.symbols).toEqual(expect.arrayContaining(['query', 'connect']));
    expect(tree.modules.auth.files).toEqual(expect.arrayContaining(['src/auth.ts']));
    expect(tree.modules.db.files).toEqual(expect.arrayContaining(['src/db.ts']));
  });

  it('review mode does not generate module pages', async () => {
    const repoPath = makeTempDir('review-no-pages');
    const graph = buildTestGraph();

    await generateWiki({
      repoPath,
      repoName: 'test-repo',
      graph,
      review: true,
    });

    const wikiDir = join(repoPath, '.astrolabe', 'wiki');
    const files = readdirSync(wikiDir);
    // Only module_tree.json should exist — no .md or .html files
    expect(files).toEqual(['module_tree.json']);
    expect(files.some((f) => f.endsWith('.md') || f.endsWith('.html'))).toBe(false);
  });

  it('resume mode reads module_tree.json and generates pages', async () => {
    const repoPath = makeTempDir('resume');
    const wikiDir = join(repoPath, '.astrolabe', 'wiki');
    mkdirSync(wikiDir, { recursive: true });

    // Write module_tree.json (simulates prior --review run)
    const treeData = {
      modules: {
        auth: { symbols: ['login', 'authenticate'], files: ['src/auth.ts'] },
        db: { symbols: ['query', 'connect'], files: ['src/db.ts'] },
      },
    };
    writeFileSync(join(wikiDir, 'module_tree.json'), JSON.stringify(treeData, null, 2), 'utf-8');

    // Empty graph — resume uses module_tree.json, not the graph
    const graph = createKnowledgeGraph();

    const result = await generateWiki({
      repoPath,
      repoName: 'test-repo',
      graph,
      resume: true,
    });

    expect(result.pageCount).toBe(2);
    expect(result.moduleCount).toBe(2);

    // Module .md files exist
    expect(existsSync(join(wikiDir, 'auth.md'))).toBe(true);
    expect(existsSync(join(wikiDir, 'db.md'))).toBe(true);

    // Overview and HTML viewer exist
    expect(existsSync(join(wikiDir, 'README.md'))).toBe(true);
    expect(existsSync(join(wikiDir, 'index.html'))).toBe(true);

    // Verify module page content uses symbols from module_tree.json
    const authContent = readFileSync(join(wikiDir, 'auth.md'), 'utf-8');
    expect(authContent).toContain('`login`');
    expect(authContent).toContain('`authenticate`');
  });

  it('gist option adds gistUrl when gh succeeds', async () => {
    const repoPath = makeTempDir('gist-success');
    const graph = buildTestGraph();

    // Mock: gh gist create succeeds (now uses execFileSync), git commands fail
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo'); });
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === 'gh' && args && args[0] === 'gist' && args[1] === 'create') {
        return 'https://gist.github.com/testuser/abc123def456\n';
      }
      throw new Error('unknown command');
    });

    const result = await generateWiki({
      repoPath,
      repoName: 'test-repo',
      graph,
      gist: true,
    });

    expect(result.gistUrl).toBe('https://gist.github.com/testuser/abc123def456');
    expect(result.pageCount).toBe(2);
  });

  it('gist handles gh failure gracefully', async () => {
    const repoPath = makeTempDir('gist-failure');
    const graph = buildTestGraph();

    // All commands fail (gh not installed)
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo'); });
    mockExecFileSync.mockImplementation(() => { throw new Error('gh: command not found'); });

    const result = await generateWiki({
      repoPath,
      repoName: 'test-repo',
      graph,
      gist: true,
    });

    // Generation still succeeds
    expect(result.pageCount).toBe(2);
    expect(result.moduleCount).toBe(2);
    // gistUrl is undefined since gh failed
    expect(result.gistUrl).toBeUndefined();
  });
});
