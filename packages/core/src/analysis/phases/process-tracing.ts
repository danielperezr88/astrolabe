/**
 * Process tracing — execution flow extraction.
 *
 * Identifies entry points and traces execution paths through the graph,
 * producing Process nodes with STEP_IN_PROCESS edges.
 *
 * Future: full call-graph traversal from entry points.
 */
export const processTracingPhase = {
  name: 'process-tracing',
  dependencies: ['resolution', 'mro'],
  execute: () => ({ message: 'Process tracing — call-graph traversal coming in future release.' }),
};
