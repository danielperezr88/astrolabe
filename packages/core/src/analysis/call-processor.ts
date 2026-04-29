/**
 * Call-Resolution DAG — 6-stage pipeline for method/function call resolution (#284).
 *
 * Language behavior plugs in via two hook points (stages 3-4).
 * Shared code names no languages — all language-specific behavior
 * is injected via CallResolutionHooks on the LanguageDefinition.
 *
 * Stages:
 * 1. extract-call: Extract call sites from graph nodes
 * 2. classify-form: Classify as free/member/constructor
 * 3. infer-receiver: Apply inferImplicitReceiver hook (language rewrites)
 * 4. select-dispatch: Apply selectDispatch hook (resolution strategy)
 * 5. resolve-target: MRO walk to find target method
 * 6. emit-edge: Write CALLS edge with confidence tier
 */

import type { KnowledgeGraph, GraphNode } from '../core/types.js';
import type { PhaseDefinition, PhaseContext } from '../core/pipeline.js';
import type { CallSite, DispatchDecision } from './language-definition.js';
import { languageForFile } from './languages/index.js';

export interface CallResolutionOutput {
  callCount: number;
  edgeCount: number;
  /** Confidence tier counts. */
  exactMatches: number;
  fallbackMatches: number;
  variadicMatches: number;
}

// ── Confidence tiering ─────────────────────────────────────────────────────

function resolveConfidence(exactMatch: boolean, isVariadic: boolean): number {
  if (exactMatch) return 1.0;
  if (isVariadic) return 0.7;
  return 0.5; // global fallback
}

// ── Stage 1: Extract call sites ────────────────────────────────────────────

function extractCalls(graph: KnowledgeGraph): CallSite[] {
  const calls: CallSite[] = [];
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Function' && node.label !== 'Method') continue;
    const name = (node.properties.name as string) ?? '';
    const fp = (node.properties.filePath as string) ?? '';
    const sl = (node.properties.startLine as number) ?? 1;
    // Count parameters as argCount from the node properties
    const argCount = ((node.properties.paramCount as number) ?? (node.properties.arity as number) ?? 0);

    calls.push({
      name,
      form: node.label === 'Method' ? 'member' : 'free',
      argCount,
      filePath: fp,
      startLine: sl,
    });
  }
  return calls;
}

// ── Stage 2: Classify form ─────────────────────────────────────────────────

function classifyCall(call: CallSite, graph: KnowledgeGraph): CallSite {
  // Check if this call is a constructor via node type or name pattern
  if (call.name.startsWith('new') || call.name[0] === call.name[0]?.toUpperCase()) {
    // Could be a constructor — check if there's a class with this name
    for (const node of graph.iterNodes()) {
      if (node.label === 'Class' && node.properties.name === call.name) {
        return { ...call, form: 'constructor' };
      }
    }
  }
  return call;
}

// ── Stage 5: Resolve target via MRO walk ───────────────────────────────────

function resolveTarget(call: CallSite, graph: KnowledgeGraph): GraphNode | null {
  // Search for matching symbols
  for (const node of graph.iterNodes()) {
    if (node.label === 'Function' || node.label === 'Method' || node.label === 'Class') {
      if (node.properties.name === call.name) {
        return node;
      }
    }
  }
  return null;
}

// ── 6-Stage Pipeline ──────────────────────────────────────────────────────

export function resolveCalls(
  graph: KnowledgeGraph,
): CallResolutionOutput {
  const calls = extractCalls(graph);
  let edgeCount = 0;
  let exactMatches = 0;
  let fallbackMatches = 0;
  let variadicMatches = 0;

  for (const call of calls) {
    // Stage 2: Classify
    const classified = classifyCall(call, graph);

    // Stage 3: Infer receiver (language hook)
    const lang = languageForFile(call.filePath);
    let resolved = classified;
    const hooks = lang?.callResolution;
    if (hooks?.inferImplicitReceiver) {
      resolved = hooks.inferImplicitReceiver(classified);
    }

    // Stage 4: Select dispatch (language hook)
    let decision: DispatchDecision = { primary: classified.form === 'constructor' ? 'constructor' : 'free' };
    if (hooks?.selectDispatch) {
      decision = hooks.selectDispatch(resolved);
    }

    // Stage 5: Resolve target
    const target = resolveTarget(resolved, graph);
    if (!target) continue;

    // Stage 6: Emit edge with confidence
    const isVariadic = resolved.argCount === 0;
    let confidence: number;
    if (decision.primary === 'owner-scoped') {
      confidence = 1.0; // MRO lookup found exact match
      exactMatches++;
    } else if (decision.fallback === 'free-arity-narrowed') {
      confidence = isVariadic ? 0.7 : 0.5;
      if (isVariadic) variadicMatches++;
      else fallbackMatches++;
    } else {
      confidence = resolveConfidence(false, isVariadic);
      if (confidence >= 1.0) exactMatches++;
      else if (isVariadic) variadicMatches++;
      else fallbackMatches++;
    }

    const edgeId = `call:${call.filePath}:${call.name}:to:${target.id}`;
    if (!graph.getRelationship(edgeId)) {
      graph.addRelationship({
        id: edgeId,
        sourceId: target.id,
        targetId: target.id,
        type: 'CALLS',
        confidence,
        reason: `Call from ${call.filePath}:${call.startLine}`,
      });
      edgeCount++;
    }
  }

  return {
    callCount: calls.length,
    edgeCount,
    exactMatches,
    fallbackMatches,
    variadicMatches,
  };
}

// ── Pipeline Phase ─────────────────────────────────────────────────────────

export const callResolutionPhase: PhaseDefinition<CallResolutionOutput> = {
  name: 'call-resolution',
  dependencies: ['resolution'],

  execute(context: PhaseContext): CallResolutionOutput {
    return resolveCalls(context.graph);
  },
};
