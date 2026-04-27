/**
 * Astrolabe — Pipeline orchestrator.
 *
 * Dependency-ordered DAG pipeline for codebase analysis.
 * Each phase produces typed output consumed by downstream phases.
 * The runner executes phases in topological order, passing outputs
 * through a shared context.
 *
 * Inspired by GitNexus's 12-phase ingestion pipeline.
 */

import type { KnowledgeGraph } from '@astrolabe/shared';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Shared context passed through all pipeline phases.
 * Phases read from and write to this context as they execute.
 */
export interface PhaseContext {
  /** Root path of the repository being analyzed. */
  repoPath: string;
  /** The knowledge graph being built. */
  graph: KnowledgeGraph;
  /** Free-form key-value store for inter-phase communication. */
  state: Map<string, unknown>;
  /** Progress callback. */
  onProgress: (phase: string, percent: number, message: string) => void;
  /** When the pipeline started (epoch ms). */
  pipelineStart: number;
}

/**
 * A single phase in the pipeline.
 * Each phase has a unique name, optional dependencies, and an execute function.
 */
export interface PhaseDefinition<TOutput = unknown> {
  /** Unique phase name (e.g., 'scan', 'parse', 'communities'). */
  name: string;
  /** Names of phases that must complete before this one runs. */
  dependencies: string[];
  /**
   * Execute the phase.
   * Returns the typed output that can be retrieved by downstream phases
   * via `context.state.get('output:<phaseName>')`.
   */
  execute: (context: PhaseContext) => Promise<TOutput> | TOutput;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run a set of pipeline phases in dependency order.
 *
 * Phases are executed in topological order based on their `dependencies`.
 * Cycles in the dependency graph will cause an error.
 * Each phase's output is stored in `context.state` keyed by `output:<name>`.
 *
 * @returns Ordered array of phase results in execution order.
 */
export async function runPipeline(
  phases: PhaseDefinition[],
  context: PhaseContext,
): Promise<unknown[]> {
  const sorted = topologicalSort(phases);
  const results: unknown[] = [];

  for (const phase of sorted) {
    const start = Date.now();
    context.onProgress(phase.name, 0, `Starting ${phase.name}...`);

    const output = await phase.execute(context);

    // Store output for downstream phases
    context.state.set(`output:${phase.name}`, output);

    const elapsed = Date.now() - start;
    context.onProgress(phase.name, 100, `${phase.name} complete (${elapsed}ms)`);
    results.push(output);
  }

  return results;
}

/**
 * Retrieve a phase's output from the shared context.
 * Generic typed accessor — pass the expected output type.
 */
export function getPhaseOutput<T>(context: PhaseContext, phaseName: string): T {
  return context.state.get(`output:${phaseName}`) as T;
}

/**
 * Create a pipeline context for a given repo path and graph.
 */
export function createPhaseContext(
  repoPath: string,
  graph: KnowledgeGraph,
  onProgress: PhaseContext['onProgress'],
): PhaseContext {
  return {
    repoPath,
    graph,
    state: new Map(),
    onProgress,
    pipelineStart: Date.now(),
  };
}

// ── Topological sort ───────────────────────────────────────────────────────

/**
 * Topological sort using Kahn's algorithm.
 * Throws if a cycle is detected.
 */
function topologicalSort(phases: PhaseDefinition[]): PhaseDefinition[] {
  const nameToPhase = new Map<string, PhaseDefinition>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const phase of phases) {
    nameToPhase.set(phase.name, phase);
    inDegree.set(phase.name, 0);
    adjacency.set(phase.name, []);
  }

  // Build graph
  for (const phase of phases) {
    for (const dep of phase.dependencies) {
      if (!nameToPhase.has(dep)) {
        throw new Error(
          `Pipeline cycle/error: phase "${phase.name}" depends on "${dep}" which does not exist.`,
        );
      }
      adjacency.get(dep)!.push(phase.name);
      inDegree.set(phase.name, (inDegree.get(phase.name) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted: PhaseDefinition[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const phase = nameToPhase.get(name)!;
    sorted.push(phase);

    for (const neighbor of adjacency.get(name) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== phases.length) {
    throw new Error(
      `Pipeline cycle detected: only ${sorted.length}/${phases.length} phases could be ordered.`,
    );
  }

  return sorted;
}
