import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../../src/core/graph.js';
import { computeGraphCoverageMetrics } from '../../../src/analysis/coverage/graph-metrics.js';
import type { KnowledgeGraph } from '@astrolabe-dev/shared';

function createTestGraph(): KnowledgeGraph {
  const graph = createKnowledgeGraph();

  // Create community nodes
  graph.addNode({ id: 'community:1', label: 'Community', properties: { name: 'core', symbolCount: 3 } });
  graph.addNode({ id: 'community:2', label: 'Community', properties: { name: 'utils', symbolCount: 2 } });

  // Create function nodes with coverage
  graph.addNode({ id: 'fn1', label: 'Function', properties: { name: 'coveredFn', filePath: 'src/core.ts', _coverageStatus: 'covered', _coverage: { lineCoverage: 95, functionCoverage: 100, uncoveredLines: [] } } });
  graph.addNode({ id: 'fn2', label: 'Function', properties: { name: 'uncoveredFn', filePath: 'src/core.ts', _coverageStatus: 'uncovered', _coverage: { lineCoverage: 0, functionCoverage: 0, uncoveredLines: [10, 20] } } });
  graph.addNode({ id: 'fn3', label: 'Method', properties: { name: 'partialMethod', filePath: 'src/core.ts', _coverageStatus: 'partial', _coverage: { lineCoverage: 45, functionCoverage: 50, uncoveredLines: [30] } } });
  graph.addNode({ id: 'fn4', label: 'Function', properties: { name: 'utilFn', filePath: 'src/utils.ts', _coverageStatus: 'covered', _coverage: { lineCoverage: 88, functionCoverage: 100, uncoveredLines: [] } } });
  graph.addNode({ id: 'fn5', label: 'Function', properties: { name: 'helperFn', filePath: 'src/utils.ts', _coverageStatus: 'uncovered', _coverage: { lineCoverage: 0, functionCoverage: 0, uncoveredLines: [5] } } });

  // Community membership
  graph.addRelationship({ id: 'mem1', sourceId: 'fn1', targetId: 'community:1', type: 'MEMBER_OF', confidence: 0.7, reason: 'core member' });
  graph.addRelationship({ id: 'mem2', sourceId: 'fn2', targetId: 'community:1', type: 'MEMBER_OF', confidence: 0.7, reason: 'core member' });
  graph.addRelationship({ id: 'mem3', sourceId: 'fn3', targetId: 'community:1', type: 'MEMBER_OF', confidence: 0.7, reason: 'core member' });
  graph.addRelationship({ id: 'mem4', sourceId: 'fn4', targetId: 'community:2', type: 'MEMBER_OF', confidence: 0.7, reason: 'utils member' });
  graph.addRelationship({ id: 'mem5', sourceId: 'fn5', targetId: 'community:2', type: 'MEMBER_OF', confidence: 0.7, reason: 'utils member' });

  // CALLS edges (fn1→fn2, fn1→fn3, fn3→fn4, fn4→fn5)
  graph.addRelationship({ id: 'call1', sourceId: 'fn1', targetId: 'fn2', type: 'CALLS', confidence: 0.8, reason: 'covered→uncovered' });
  graph.addRelationship({ id: 'call2', sourceId: 'fn1', targetId: 'fn3', type: 'CALLS', confidence: 0.8, reason: 'covered→partial' });
  graph.addRelationship({ id: 'call3', sourceId: 'fn3', targetId: 'fn4', type: 'CALLS', confidence: 0.8, reason: 'partial→covered' });
  graph.addRelationship({ id: 'call4', sourceId: 'fn4', targetId: 'fn5', type: 'CALLS', confidence: 0.8, reason: 'covered→uncovered' });

  return graph;
}

describe('computeGraphCoverageMetrics', () => {
  it('computes correct overall node coverage percentages', () => {
    const graph = createTestGraph();
    const metrics = computeGraphCoverageMetrics(graph);

    expect(metrics.totalFunctionNodes).toBe(5);
    expect(metrics.coveredFunctionNodes).toBe(2);   // fn1, fn4
    expect(metrics.partialFunctionNodes).toBe(1);    // fn3
    expect(metrics.uncoveredFunctionNodes).toBe(2);  // fn2, fn5
    expect(metrics.overallNodeCoveragePercent).toBeCloseTo(40, 0); // 2/5 fully covered
  });

  it('computes correct edge coverage', () => {
    const graph = createTestGraph();
    const metrics = computeGraphCoverageMetrics(graph);

    expect(metrics.totalCallEdges).toBe(4);
    // Only edges where BOTH endpoints are 'covered': fn1→fn2 (NO), fn1→fn3 (NO), fn3→fn4 (NO), fn4→fn5 (NO)
    expect(metrics.coveredCallEdges).toBe(0);
    expect(metrics.overallEdgeCoveragePercent).toBe(0);
  });

  it('computes per-community breakdown', () => {
    const graph = createTestGraph();
    const metrics = computeGraphCoverageMetrics(graph);

    expect(metrics.communities).toHaveLength(2);

    const core = metrics.communities.find((c) => c.communityName === 'core')!;
    expect(core).toBeDefined();
    expect(core.totalNodes).toBe(3);
    expect(core.coveredNodes).toBe(1);  // fn1
    expect(core.partialNodes).toBe(1);  // fn3
    expect(core.uncoveredNodes).toBe(1); // fn2

    const utils = metrics.communities.find((c) => c.communityName === 'utils')!;
    expect(utils).toBeDefined();
    expect(utils.totalNodes).toBe(2);
    expect(utils.coveredNodes).toBe(1);   // fn4
    expect(utils.uncoveredNodes).toBe(1); // fn5
  });

  it('returns zeros for empty graph', () => {
    const graph = createKnowledgeGraph();
    const metrics = computeGraphCoverageMetrics(graph);

    expect(metrics.totalFunctionNodes).toBe(0);
    expect(metrics.communities).toEqual([]);
    expect(metrics.topUntestedHighImpact).toEqual([]);
  });

  it('identifies top untested high-impact nodes', () => {
    const graph = createTestGraph();
    const metrics = computeGraphCoverageMetrics(graph);

    // fn2 has 1 incoming call (from fn1), fn5 has 1 incoming call (from fn4)
    // Both are uncovered
    expect(metrics.topUntestedHighImpact.length).toBeGreaterThanOrEqual(1);

    const fn2Gap = metrics.topUntestedHighImpact.find((g) => g.name === 'uncoveredFn');
    expect(fn2Gap).toBeDefined();
    expect(fn2Gap!.impact).toBe(1);
  });

  it('handles nodes with no coverage data by treating as uncovered', () => {
    const graph = createKnowledgeGraph();
    // Node with no _coverageStatus at all
    graph.addNode({ id: 'fn1', label: 'Function', properties: { name: 'noCov', filePath: 'src/x.ts' } });
    graph.addNode({ id: 'fn2', label: 'Function', properties: { name: 'hasCov', filePath: 'src/x.ts', _coverageStatus: 'covered', _coverage: { lineCoverage: 90, functionCoverage: 100, uncoveredLines: [] } } });

    const metrics = computeGraphCoverageMetrics(graph);
    expect(metrics.totalFunctionNodes).toBe(2);
    expect(metrics.coveredFunctionNodes).toBe(1);
    expect(metrics.uncoveredFunctionNodes).toBe(1);
  });
});