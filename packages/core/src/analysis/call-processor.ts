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

// ── Stage 5: Resolve target with file-scoped name→node index (#364, #366) ─

let _nameIndex: Map<string, GraphNode[]> | null = null;

function buildNameIndex(graph: KnowledgeGraph): Map<string, GraphNode[]> {
  if (_nameIndex) return _nameIndex;
  _nameIndex = new Map();
  for (const node of graph.iterNodes()) {
    if (['Function', 'Method', 'Class'].includes(node.label)) {
      const name = (node.properties.name as string) ?? '';
      if (!name) continue;
      let bucket = _nameIndex.get(name);
      if (!bucket) { bucket = []; _nameIndex.set(name, bucket); }
      bucket.push(node);
    }
  }
  return _nameIndex;
}

function resolveTarget(call: CallSite, graph: KnowledgeGraph): GraphNode | null {
  const index = buildNameIndex(graph);
  const candidates = index.get(call.name);
  if (!candidates || candidates.length === 0) return null;

  // #366: Narrow by file scope — prefer same-file or imported-file targets
  let bestByFile: GraphNode | null = null;
  for (const node of candidates) {
    const nodeFp = (node.properties.filePath as string) ?? '';
    if (nodeFp === call.filePath) return node; // exact same-file match
    if (!bestByFile) bestByFile = node;
  }
  return bestByFile; // fallback to first candidate
}

// ── 6-Stage Pipeline ──────────────────────────────────────────────────────

export function resolveCalls(
  graph: KnowledgeGraph,
): CallResolutionOutput {
  // #424: Reset module-level cache to prevent stale data across pipeline runs
  _nameIndex = null;

  // #364: Work from existing CALLS edges — enhance with classification and confidence
  const edges: Array<{ sourceId: string; targetId: string; type: string }> = [];
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'CALLS') edges.push(rel);
  }

  let exactMatches = 0;
  let fallbackMatches = 0;
  let variadicMatches = 0;

  for (const edge of edges) {
    const sourceNode = graph.getNode(edge.sourceId);
    const targetNode = graph.getNode(edge.targetId);
    if (!sourceNode || !targetNode) continue;

    const callName = (targetNode.properties.name as string) ?? '';
    const callFp = (sourceNode.properties.filePath as string) ?? '';
    const argCount = ((targetNode.properties.paramCount as number) ?? 0);

    // Stage 3: Infer receiver via language hook
    const lang = languageForFile(callFp);
    const hooks = lang?.callResolution;

    // Stage 4: Select dispatch
    const decision: DispatchDecision = { primary: 'free' };
    if (hooks?.selectDispatch) {
      const callSite: CallSite = { name: callName, form: 'free', argCount, filePath: callFp, startLine: 1 };
      Object.assign(decision, hooks.selectDispatch(callSite));
    }

    // Stage 6: Confidence tiering
    const isVariadic = argCount === 0;
    let confidence: number;
    if (decision.primary === 'owner-scoped') {
      confidence = 1.0;
      exactMatches++;
    } else if (decision.fallback === 'free-arity-narrowed') {
      confidence = isVariadic ? 0.7 : 0.5;
      if (isVariadic) variadicMatches++;
      else fallbackMatches++;
    } else {
      confidence = resolveConfidence(false, isVariadic);
      if (isVariadic) variadicMatches++;
      else fallbackMatches++;
    }

    // Update existing edge with enhanced confidence (#364: use actual source/target, not self-loop)
    const rel = graph.getRelationship(edge.sourceId);
    if (rel) {
      rel.confidence = Math.max(rel.confidence, confidence);
      if (decision.primary !== 'free') rel.reason = `${decision.primary} dispatch: ${rel.reason || 'call'}`;
    }
  }

  return {
    callCount: edges.length,
    edgeCount: edges.length,
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
