/**
 * Tests for the pipeline orchestrator.
 */

import { describe, it, expect } from 'vitest';
import { runPipeline, createPhaseContext, getPhaseOutput } from '../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../src/core/graph.js';
import type { PhaseDefinition } from '../../src/core/pipeline.js';

describe('Pipeline', () => {
  describe('runPipeline', () => {
    it('runs phases in dependency order', async () => {
      const order: string[] = [];
      const graph = createKnowledgeGraph();
      const context = createPhaseContext('/test', graph, () => {});

      const phaseA: PhaseDefinition = {
        name: 'A',
        dependencies: [],
        execute: async () => { order.push('A'); return 'resultA'; },
      };
      const phaseB: PhaseDefinition = {
        name: 'B',
        dependencies: ['A'],
        execute: async () => { order.push('B'); return 'resultB'; },
      };
      const phaseC: PhaseDefinition = {
        name: 'C',
        dependencies: ['A'],
        execute: async () => { order.push('C'); return 'resultC'; },
      };

      await runPipeline([phaseC, phaseB, phaseA], context);

      // A must come first; B and C are unordered (same dependency depth)
      expect(order[0]).toBe('A');
      expect(order.slice(1).sort()).toEqual(['B', 'C']);
    });

    it('stores outputs accessible via getPhaseOutput', async () => {
      const graph = createKnowledgeGraph();
      const context = createPhaseContext('/test', graph, () => {});

      const phaseA: PhaseDefinition = {
        name: 'scan',
        dependencies: [],
        execute: () => ({ files: ['a.ts', 'b.ts'] }),
      };

      await runPipeline([phaseA], context);
      expect(getPhaseOutput<{ files: string[] }>(context, 'scan')).toEqual({ files: ['a.ts', 'b.ts'] });
    });

    it('throws on cycle', async () => {
      const graph = createKnowledgeGraph();
      const context = createPhaseContext('/test', graph, () => {});

      const phaseA: PhaseDefinition = {
        name: 'A',
        dependencies: ['B'],
        execute: async () => {},
      };
      const phaseB: PhaseDefinition = {
        name: 'B',
        dependencies: ['A'],
        execute: async () => {},
      };

      await expect(runPipeline([phaseA, phaseB], context)).rejects.toThrow(/cycle/i);
    });

    it('allows phase with dependency not in current pipeline (pre-run in separate pipeline call)', async () => {
      const graph = createKnowledgeGraph();
      const context = createPhaseContext('/test', graph, () => {});
      // Pre-seed the context with a dependency output from a previous pipeline run
      context.state.set('output:NONEXISTENT', {});

      const phaseA: PhaseDefinition = {
        name: 'A',
        dependencies: ['NONEXISTENT'],
        execute: async () => {},
      };

      // Should succeed — dependency resolution was handled by a prior pipeline call
      const result = await runPipeline([phaseA], context);
      expect(result).toHaveLength(1);
    });

    it('handles single phase', async () => {
      const graph = createKnowledgeGraph();
      const context = createPhaseContext('/test', graph, () => {});
      let ran = false;

      await runPipeline([{
        name: 'only',
        dependencies: [],
        execute: async () => { ran = true; },
      }], context);

      expect(ran).toBe(true);
    });
  });
});
