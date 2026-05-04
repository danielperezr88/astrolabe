/**
 * PhaseTimer — High-resolution timing for queries and pipeline phases.
 *
 * Instruments MCP tool handlers and pipeline phases with structured
 * timing information emitted to stderr (stdout is reserved for MCP protocol).
 *
 * Usage:
 *   const timer = new PhaseTimer('query');
 *   timer.start();
 *   // ... search logic ...
 *   timer.mark('search');
 *   // ... formatting ...
 *   timer.stop();
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface PhaseTimerResult {
  tool: string;
  totalMs: number;
  phases: Record<string, number>;
}

// ── PhaseTimer ─────────────────────────────────────────────────────────────

export class PhaseTimer {
  private phases: Map<string, number> = new Map();
  private startMark: number = 0;
  private endMark: number = 0;
  private toolName: string;

  constructor(toolName: string) {
    this.toolName = toolName;
  }

  /** Start overall timing. */
  start(): void {
    this.startMark = performance.now();
  }

  /**
   * Record a sub-phase duration from the previous mark (or start).
   * Each call creates a new phase entry measured from the last mark/start.
   */
  mark(label: string): void {
    const now = performance.now();
    const prev = this.phases.size === 0 ? this.startMark : this.endMark;
    const elapsed = now - prev;
    this.phases.set(label, elapsed);
    this.endMark = now;
  }

  /**
   * Start a sub-phase (returns start time for manual stop).
   * Use when you need precise control over phase boundaries,
   * e.g. when phases overlap or are non-sequential.
   */
  startPhase(label: string): number {
    // Store start time with a special prefix key
    const startTime = performance.now();
    this.phases.set(`__start_${label}`, startTime);
    return startTime;
  }

  /**
   * Stop a sub-phase started with startPhase.
   * Computes and stores the elapsed duration under the label.
   */
  stopPhase(label: string, startTime: number): void {
    const elapsed = performance.now() - startTime;
    // Remove the internal start marker and store the duration
    this.phases.delete(`__start_${label}`);
    this.phases.set(label, elapsed);
  }

  /**
   * Stop overall timing and emit structured log to stderr.
   * Returns the formatted result.
   */
  stop(): PhaseTimerResult {
    const totalMs = performance.now() - this.startMark;
    const result = this.getResult();
    // Emit structured timing to stderr (not stdout — that's for MCP protocol)
    const phasesStr = Object.entries(result.phases)
      .map(([k, v]) => `${k}: ${Math.round(v)}`)
      .join(', ');
    console.error(`Astrolabe [${this.toolName}:timing] tool=${this.toolName} totalMs=${Math.round(totalMs)} phases={${phasesStr}}`);
    return result;
  }

  /** Get the formatted result without emitting a log. */
  getResult(): PhaseTimerResult {
    const totalMs = this.endMark > 0
      ? this.endMark - this.startMark
      : performance.now() - this.startMark;
    const phases: Record<string, number> = {};
    for (const [key, value] of this.phases) {
      // Skip internal start markers that weren't stopped
      if (key.startsWith('__start_')) continue;
      phases[key] = Math.round(value * 1000) / 1000;
    }
    return {
      tool: this.toolName,
      totalMs: Math.round(totalMs * 1000) / 1000,
      phases,
    };
  }
}
