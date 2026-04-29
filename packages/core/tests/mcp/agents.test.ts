/**
 * Tests for AGENTS.md/CLAUDE.md generation (#268) and Community Skills (#267).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync, unlinkSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateAgentFiles, type AgentFilesResult } from '../../src/agents/index.js';
import { createKnowledgeGraph } from '../../src/core/graph.js';

function createTestGraph() {
  const g = createKnowledgeGraph();
  // Add some test nodes
  g.addNode({ id: 'func:auth', label: 'Function', properties: { name: 'login', filePath: 'src/auth.ts' } });
  g.addNode({ id: 'func:pay', label: 'Function', properties: { name: 'processPayment', filePath: 'src/billing.ts' } });
  g.addNode({ id: 'class:User', label: 'Class', properties: { name: 'User', filePath: 'src/models.ts' } });
  g.addNode({ id: 'route:1', label: 'Route', properties: { name: 'GET /api/users', method: 'GET', path: '/api/users' } });
  g.addNode({ id: 'process:1', label: 'Process', properties: { name: 'user-auth-flow' } });
  g.addNode({ id: 'comm:core', label: 'Community', properties: { name: 'auth-module', symbolCount: 2 } });

  // MEMBER_OF edges for community membership
  g.addRelationship({ id: 'rel:1', sourceId: 'func:auth', targetId: 'comm:core', type: 'MEMBER_OF', confidence: 1, reason: 'community' });
  g.addRelationship({ id: 'rel:2', sourceId: 'func:pay', targetId: 'comm:core', type: 'MEMBER_OF', confidence: 1, reason: 'community' });

  return g;
}

describe('Agents/CLAUDE.md Generation (#268)', () => {
  const repoPath = join(tmpdir(), 'astrolabe-agents-test-' + Date.now());
  const opts = {
    repoName: 'test-project',
    repoPath,
    nodeCount: 1200,
    relationshipCount: 3500,
    processCount: 45,
    communityCount: 8,
    routeCount: 15,
    toolCount: 3,
    lastCommit: 'abcdef1234567890',
    isIncremental: false,
  };

  beforeAll(() => {
    mkdirSync(repoPath, { recursive: true });
  });

  afterAll(() => {
    try { unlinkSync(join(repoPath, 'AGENTS.md')); } catch {}
    try { unlinkSync(join(repoPath, 'CLAUDE.md')); } catch {}
    try { rmSync(join(repoPath, '.astrolabe'), { recursive: true, force: true }); } catch {}
    try { rmSync(repoPath, { recursive: true, force: true }); } catch {}
  });

  it('generates AGENTS.md and CLAUDE.md', () => {
    const result = generateAgentFiles(repoPath, opts);
    expect(result.agentsMd).toBe(true);
    expect(result.claudeMd).toBe(true);

    const agentsContent = readFileSync(join(repoPath, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('<!-- astrolabe:start -->');
    expect(agentsContent).toContain('<!-- astrolabe:end -->');
    expect(agentsContent).toContain('1200 symbols');
    expect(agentsContent).toContain('test-project');
    expect(agentsContent).toContain('abcdef1');
  });

  it('CLAUDE.md contains same block markers', () => {
    generateAgentFiles(repoPath, opts);
    const content = readFileSync(join(repoPath, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('<!-- astrolabe:start -->');
    expect(content).toContain('<!-- astrolabe:end -->');
  });

  it('preserves user content outside astrolabe block', () => {
    const agentsPath = join(repoPath, 'AGENTS.md');
    // First generation
    generateAgentFiles(repoPath, opts);

    // Add user content outside the block
    const withUser = readFileSync(agentsPath, 'utf-8') + '\n# My Custom Notes\nThis is user content.\n';
    writeFileSync(agentsPath, withUser, 'utf-8');

    // Re-generate (should preserve user content)
    generateAgentFiles(repoPath, opts);
    const updated = readFileSync(agentsPath, 'utf-8');
    expect(updated).toContain('My Custom Notes');
    expect(updated).toContain('user content');
  });

  it('replaces existing block content on re-generation', () => {
    const agentsPath = join(repoPath, 'AGENTS.md');
    const oldOpts = { ...opts, nodeCount: 500 };
    generateAgentFiles(repoPath, oldOpts);
    const oldContent = readFileSync(agentsPath, 'utf-8');
    expect(oldContent).toContain('500 symbols');

    const newOpts = { ...opts, nodeCount: 999 };
    generateAgentFiles(repoPath, newOpts);
    const newContent = readFileSync(agentsPath, 'utf-8');
    expect(newContent).toContain('999 symbols');
    expect(newContent).not.toContain('500 symbols');
  });

  it('handles incremental mode', () => {
    const incOpts = { ...opts, isIncremental: true };
    const result = generateAgentFiles(repoPath, incOpts);
    expect(result.agentsMd).toBe(true);
  });

  it('includes MCP tool references', () => {
    generateAgentFiles(repoPath, opts);
    const content = readFileSync(join(repoPath, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('astrolabe.query');
    expect(content).toContain('astrolabe.context');
    expect(content).toContain('astrolabe.impact');
  });
});

describe('Community Skills (#267)', () => {
  const skillsPath = join(tmpdir(), 'astrolabe-skills-test-' + Date.now());
  const graph = createTestGraph();

  beforeAll(() => {
    mkdirSync(skillsPath, { recursive: true });
  });

  afterAll(() => {
    try { rmSync(skillsPath, { recursive: true, force: true }); } catch {}
  });

  it('generates skill files for each community with --skills flag', () => {
    const result = generateAgentFiles(skillsPath, {
      repoName: 'test-project',
      repoPath: skillsPath,
      nodeCount: graph.nodeCount,
      relationshipCount: graph.relationshipCount,
      processCount: 1,
      communityCount: 1,
      routeCount: 1,
      toolCount: 0,
      lastCommit: 'abc123',
      isIncremental: false,
      graph,
      skills: true,
    });

    expect(result.skillsCount).toBeGreaterThan(0);
    const skillsDir = join(skillsPath, '.astrolabe', 'skills');
    expect(existsSync(skillsDir)).toBe(true);

    // Should have at least one .md file
    const authSkill = join(skillsDir, 'auth-module.md');
    expect(existsSync(authSkill)).toBe(true);

    const content = readFileSync(authSkill, 'utf-8');
    expect(content).toContain('# auth-module');
    expect(content).toContain('astrolabe.query');
  });

  it('does not generate skills when skills flag is off', () => {
    const result = generateAgentFiles(skillsPath, {
      repoName: 'test-project',
      repoPath: skillsPath,
      nodeCount: 10,
      relationshipCount: 5,
      processCount: 0,
      communityCount: 0,
      routeCount: 0,
      toolCount: 0,
      lastCommit: 'abc123',
      isIncremental: false,
      graph,
      skills: false,
    });

    expect(result.skillsCount).toBe(0);
  });
});

