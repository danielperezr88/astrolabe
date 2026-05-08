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

  describe('incremental indexing (#632)', () => {
    it('skips phases with shouldSkip returning true', async () => {
      const graph = createKnowledgeGraph();
      const inc = {
        changedPaths: new Set<string>(),
        addedPaths: new Set<string>(),
        deletedPaths: new Set<string>(),
        unchangedPaths: new Set(['unchanged.ts']),
        isIncremental: true,
      };
      const context = createPhaseContext('/test', graph, () => {}, inc);
      const order: string[] = [];

      const phaseA: PhaseDefinition = {
        name: 'A',
        dependencies: [],
        shouldSkip: () => true, // always skip
        execute: async () => { order.push('A'); },
      };
      const phaseB: PhaseDefinition = {
        name: 'B',
        dependencies: ['A'],
        execute: async () => { order.push('B'); },
      };

      await runPipeline([phaseA, phaseB], context);

      expect(order).toEqual(['B']); // A skipped
      // Skipped phases store null output
      expect(context.state.get('output:A')).toBeNull();
      // Phase B ran and stored its output (even if undefined)
      expect(context.state.has('output:B')).toBe(true);
    });

    it('does not skip when shouldSkip returns false', async () => {
      const graph = createKnowledgeGraph();
      const context = createPhaseContext('/test', graph, () => {});
      const order: string[] = [];

      const phaseA: PhaseDefinition = {
        name: 'A',
        dependencies: [],
        shouldSkip: () => false, // explicitly do not skip
        execute: async () => { order.push('A'); },
      };

      await runPipeline([phaseA], context);

      expect(order).toEqual(['A']);
    });

    it('does not skip in full-analysis mode (no incremental context)', async () => {
      const graph = createKnowledgeGraph();
      const context = createPhaseContext('/test', graph, () => {}); // no incremental info
      const order: string[] = [];

      const phaseA: PhaseDefinition = {
        name: 'A',
        dependencies: [],
        shouldSkip: (ctx) => !!ctx.incremental?.isIncremental, // only skip if incremental
        execute: async () => { order.push('A'); },
      };

      await runPipeline([phaseA], context);

      expect(order).toEqual(['A']); // not skipped — no incremental context
    });

    it('passes IncrementalInfo to phases for selective execution', async () => {
      const graph = createKnowledgeGraph();
      const inc = {
        changedPaths: new Set(['a.ts', 'b.ts']),
        addedPaths: new Set(['c.ts']),
        deletedPaths: new Set(['d.ts']),
        unchangedPaths: new Set(['x.ts', 'y.ts']),
        isIncremental: true,
      };
      const context = createPhaseContext('/test', graph, () => {}, inc);
      const captured: string[] = [];

      const phaseA: PhaseDefinition = {
        name: 'A',
        dependencies: [],
        execute: (ctx) => {
          if (ctx.incremental) {
            captured.push(...ctx.incremental.changedPaths);
          }
        },
      };

      await runPipeline([phaseA], context);

      expect(captured.sort()).toEqual(['a.ts', 'b.ts']);
    });
  });
});
