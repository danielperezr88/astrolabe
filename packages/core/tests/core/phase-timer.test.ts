/**
 * Tests for the PhaseTimer utility.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PhaseTimer } from '../../src/core/phase-timer.js';
import type { PhaseTimerResult } from '../../src/core/phase-timer.js';

describe('PhaseTimer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('start/stop lifecycle', () => {
    it('records total time between start and stop', () => {
      const timer = new PhaseTimer('test');
      timer.start();
      // Simulate work — tiny delay
      const result = timer.stop();
      expect(result.tool).toBe('test');
      expect(result.totalMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.totalMs).toBe('number');
    });

    it('emits structured log to stderr on stop', () => {
      const timer = new PhaseTimer('query');
      timer.start();
      timer.mark('search');
      timer.stop();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Astrolabe [query:timing]'),
      );
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('tool=query'),
      );
    });

    it('returns zero totalMs when stop is called immediately after start', () => {
      const timer = new PhaseTimer('instant');
      timer.start();
      const result = timer.stop();
      // Even immediate calls should have >= 0 ms
      expect(result.totalMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('mark', () => {
    it('records sequential phase durations', () => {
      const timer = new PhaseTimer('test');
      timer.start();
      timer.mark('phase1');
      timer.mark('phase2');
      timer.mark('phase3');
      const result = timer.stop();
      expect(Object.keys(result.phases)).toEqual(['phase1', 'phase2', 'phase3']);
    });

    it('records positive durations for each phase', () => {
      const timer = new PhaseTimer('test');
      timer.start();
      // Busy-spin to ensure measurable elapsed time
      const end = performance.now() + 2;
      while (performance.now() < end) { /* spin */ }
      timer.mark('busy');
      const result = timer.stop();
      expect(result.phases.busy).toBeGreaterThan(0);
    });

    it('overwrites a phase when mark is called with same label', () => {
      const timer = new PhaseTimer('test');
      timer.start();
      timer.mark('phase1');
      timer.mark('phase1');
      const result = timer.stop();
      // Should have only one key 'phase1' with the second measurement
      expect(Object.keys(result.phases)).toEqual(['phase1']);
      expect(result.phases.phase1).toBeGreaterThanOrEqual(0);
    });
  });

  describe('startPhase/stopPhase', () => {
    it('records manually controlled phase duration', () => {
      const timer = new PhaseTimer('test');
      timer.start();
      const t0 = timer.startPhase('lookup');
      // Busy-spin
      const end = performance.now() + 2;
      while (performance.now() < end) { /* spin */ }
      timer.stopPhase('lookup', t0);
      const result = timer.stop();
      expect(result.phases.lookup).toBeGreaterThan(0);
    });

    it('supports overlapping phases', () => {
      const timer = new PhaseTimer('test');
      timer.start();
      const t0 = timer.startPhase('alpha');
      const t1 = timer.startPhase('beta');
      // Busy-spin
      const end = performance.now() + 2;
      while (performance.now() < end) { /* spin */ }
      timer.stopPhase('alpha', t0);
      timer.stopPhase('beta', t1);
      const result = timer.stop();
      expect(result.phases.alpha).toBeGreaterThan(0);
      expect(result.phases.beta).toBeGreaterThan(0);
    });

    it('does not include internal start markers in result', () => {
      const timer = new PhaseTimer('test');
      timer.start();
      const t0 = timer.startPhase('measured');
      timer.stopPhase('measured', t0);
      // Start a phase but never stop it
      timer.startPhase('orphaned');
      const result = timer.stop();
      // Only 'measured' should appear; 'orphaned' and '__start_orphaned' should not
      expect(Object.keys(result.phases)).toEqual(['measured']);
      expect(result.phases.orphaned).toBeUndefined();
    });
  });

  describe('getResult', () => {
    it('returns result without emitting log', () => {
      const timer = new PhaseTimer('test');
      timer.start();
      timer.mark('step1');
      const result = timer.getResult();
      expect(result.tool).toBe('test');
      expect(result.phases.step1).toBeGreaterThanOrEqual(0);
      // getResult should NOT emit to stderr
      expect(console.error).not.toHaveBeenCalled();
    });

    it('rounds phase values to 3 decimal places', () => {
      const timer = new PhaseTimer('test');
      timer.start();
      timer.mark('precise');
      const result = timer.getResult();
      // Verify no excessive precision
      const val = result.phases.precise!;
      const decimalPart = val.toString().split('.')[1];
      if (decimalPart) {
        expect(decimalPart.length).toBeLessThanOrEqual(3);
      }
    });
  });

  describe('zero and edge cases', () => {
    it('handles timer with no phases recorded', () => {
      const timer = new PhaseTimer('empty');
      timer.start();
      const result = timer.stop();
      expect(result.phases).toEqual({});
      expect(result.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('handles mixed mark and startPhase/stopPhase usage', () => {
      const timer = new PhaseTimer('hybrid');
      timer.start();
      timer.mark('sequential');
      const t0 = timer.startPhase('manual');
      const end = performance.now() + 1;
      while (performance.now() < end) { /* spin */ }
      timer.stopPhase('manual', t0);
      const result = timer.stop();
      expect(result.phases.sequential).toBeGreaterThanOrEqual(0);
      expect(result.phases.manual).toBeGreaterThanOrEqual(0);
    });
  });
});
