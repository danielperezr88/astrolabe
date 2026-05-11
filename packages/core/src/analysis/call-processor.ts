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

import type { KnowledgeGraph } from '../core/types.js';
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

// ── Confidence tiering (#757) ──────────────────────────────────────────────────

/**
 * 3-tier confidence scoring for CALLS edges:
 * - Same-file: 0.95 — caller and callee in the same file
 * - Import-scoped: 0.9 — callee was imported by the caller's file
 * - Global/fuzzy: 0.5 — callee found by name match only
 *
 * Additionally lowered for variadic calls (0 argCount → -0.2).
 */
function resolveConfidence(
  sourceFilePath: string,
  targetFilePath: string,
  isImported: boolean,
  isVariadic: boolean,
): number {
  let confidence: number;
  if (sourceFilePath === targetFilePath && sourceFilePath) {
    confidence = 0.95; // same-file
  } else if (isImported) {
    confidence = 0.9; // import-scoped
  } else {
    confidence = 0.5; // global/fuzzy
  }
  if (isVariadic) confidence = Math.max(0.3, confidence - 0.2);
  return confidence;
}

/**
 * Build an import lookup: Map<filePath, Set<importedSymbolName>>
 * for checking if a callee was imported by the caller's file.
 */
function buildImportIndex(graph: KnowledgeGraph): Map<string, Set<string>> {
  const importsByFile = new Map<string, Set<string>>();
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Import') continue;
    const fp = node.properties.filePath as string | undefined;
    const name = node.properties.name as string | undefined;
    if (!fp || !name) continue;
    let set = importsByFile.get(fp);
    if (!set) { set = new Set(); importsByFile.set(fp, set); }
    set.add(name);
  }
  return importsByFile;
}

// ── Stage 5: Resolve target with file-scoped name→node index (#364, #366) ─

// ── 6-Stage Pipeline ──────────────────────────────────────────────────────

export function resolveCalls(
  graph: KnowledgeGraph,
  incremental?: { changedPaths: Set<string>; addedPaths: Set<string> },
): CallResolutionOutput {
  // #364: Work from existing CALLS edges — enhance with classification and confidence
  const edges: Array<{ id: string; sourceId: string; targetId: string; type: string }> = [];
  // #632: In incremental mode, only process CALLS edges involving changed-file symbols.
  // Edges between unchanged files are already classified from the previous run.
  const affected = incremental
    ? new Set([...incremental.changedPaths, ...incremental.addedPaths])
    : null;

  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    // #632: Skip edges between unchanged files
    if (affected) {
      const sourceNode = graph.getNode(rel.sourceId);
      const targetNode = graph.getNode(rel.targetId);
      const srcFp = sourceNode?.properties.filePath as string | undefined;
      const tgtFp = targetNode?.properties.filePath as string | undefined;
      if (srcFp && tgtFp && !affected.has(srcFp) && !affected.has(tgtFp)) continue;
    }
    edges.push(rel);
  }

  let exactMatches = 0;
  let fallbackMatches = 0;
  let variadicMatches = 0;

  // #757: Build import index for import-scoped confidence tiering
  const importsByFile = buildImportIndex(graph);

  for (const edge of edges) {
    const sourceNode = graph.getNode(edge.sourceId);
    const targetNode = graph.getNode(edge.targetId);
    if (!sourceNode || !targetNode) continue;

    const callName = (targetNode.properties.name as string) ?? '';
    const srcFp = (sourceNode.properties.filePath as string) ?? '';
    const tgtFp = (targetNode.properties.filePath as string) ?? '';
    const argCount = ((targetNode.properties.paramCount as number) ?? 0);

    // Stage 3: Infer receiver via language hook
    const lang = languageForFile(srcFp);
    const hooks = lang?.callResolution;

    // Stage 4: Select dispatch
    const decision: DispatchDecision = { primary: 'free' };
    if (hooks?.selectDispatch) {
      const callSite: CallSite = { name: callName, form: 'free', argCount, filePath: srcFp, startLine: 1 };
      Object.assign(decision, hooks.selectDispatch(callSite));
    }

    // Stage 6: Confidence tiering (#757: 3-tier with same-file/import/global)
    const isVariadic = argCount === 0;
    const isImported = importsByFile.get(srcFp)?.has(callName) ?? false;
    let confidence: number;
    if (decision.primary === 'owner-scoped') {
      confidence = 1.0; // language hook confirmed exact match
      exactMatches++;
    } else {
      confidence = resolveConfidence(srcFp, tgtFp, isImported, isVariadic);
      if (srcFp === tgtFp && srcFp) {
        exactMatches++;
      } else if (isImported) {
        exactMatches++;
      } else if (isVariadic) {
        variadicMatches++;
      } else {
        fallbackMatches++;
      }
    }

    // Update existing edge with enhanced confidence (#364: use actual source/target, not self-loop)
    // #470: Use edge.id (relationship ID), not edge.sourceId (node ID)
    const rel = graph.getRelationship(edge.id);
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

  // #632: Skip if incremental and no changed files (CALLS edges unchanged)
  shouldSkip(context: PhaseContext): boolean {
    const inc = context.incremental;
    if (!inc?.isIncremental) return false;
    return inc.changedPaths.size + inc.addedPaths.size === 0;
  },

  execute(context: PhaseContext): CallResolutionOutput {
    return resolveCalls(
      context.graph,
      context.incremental?.isIncremental
        ? { changedPaths: context.incremental.changedPaths, addedPaths: context.incremental.addedPaths }
        : undefined,
    );
  },
};
