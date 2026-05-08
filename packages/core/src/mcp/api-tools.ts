/**
 * API-Aware MCP Tools — route_map, api_impact, tool_map, shape_check (#270).
 *
 * Builds on existing routes/tools/ORM phase data in the knowledge graph to
 * provide API-level analysis beyond basic symbol queries.
 */

import type { KnowledgeGraph } from '../core/types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface RouteMapEntry {
  route: string;
  method: string;
  path: string;
  handlerId: string;
  handlerName: string;
  consumers: Array<{ id: string; name: string; filePath: string }>;
  isOrphaned: boolean;
  middleware: string[];
}

export interface ToolMapEntry {
  toolName: string;
  toolType: string;
  handlerId: string;
  handlerName: string;
  callers: Array<{ id: string; name: string; filePath: string }>;
  isUnused: boolean;
}

export interface ApiImpactResult {
  symbol: string;
  routes: Array<{ method: string; path: string; consumers: string[]; risk: string; middleware: string[] }>;
  tools: Array<{ type: string; name: string }>;
  shapeDrift: Array<{ field: string; severity: string }>;
}

// ── route_map ──────────────────────────────────────────────────────────────

export function routeMap(graph: KnowledgeGraph): RouteMapEntry[] {
  const routeNodes: Map<string, { method: string; path: string; handlerId: string; handlerName: string; middleware: string[] }> = new Map();

  // Collect Route nodes
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Route') continue;
    routeNodes.set(node.id, {
      method: (node.properties.method as string) ?? '?',
      path: (node.properties.path as string) ?? '?',
      handlerId: node.id,
      handlerName: (node.properties.name as string) ?? node.id,
      middleware: (node.properties.middleware as string[]) ?? [],
    });
  }

  // Build consumer map: route handler → callers
  const consumers = new Map<string, Array<{ id: string; name: string; filePath: string }>>();

  for (const rel of graph.iterRelationships()) {
    // CALLS edges — the caller calls the callee
    if (rel.type === 'CALLS') {
      const callee = graph.getNode(rel.targetId);
      if (callee) {
        const entry = consumers.get(rel.targetId) ?? [];
        const caller = graph.getNode(rel.sourceId);
        if (caller) {
          entry.push({
            id: caller.id,
            name: (caller.properties.name as string) ?? caller.id,
            filePath: (caller.properties.filePath as string) ?? '?',
          });
        }
        consumers.set(rel.targetId, entry);
      }
    }

    // IMPORTS edge — File → Import (file imports a module)
    if (rel.type === 'IMPORTS') {
      const caller = graph.getNode(rel.sourceId);
      const importNode = graph.getNode(rel.targetId);
      if (caller && importNode) {
        // Check if this import relates to a route file
        const importedPath = importNode.properties.name as string;
        for (const [routeId, route] of routeNodes) {
          const routeNode = graph.getNode(routeId);
          const routeFp = routeNode?.properties.filePath as string;
          if (routeFp && importedPath && importedPath.includes(routeFp.replace(/\.(ts|js|py|php)/, ''))) {
            const entry = consumers.get(route.handlerId) ?? [];
            entry.push({
              id: caller.id,
              name: (caller.properties.name as string) ?? caller.id,
              filePath: (caller.properties.filePath as string) ?? '?',
            });
            consumers.set(route.handlerId, entry);
          }
        }
      }
    }
  }

  // Build results
  const results: RouteMapEntry[] = [];
  for (const [, route] of routeNodes) {
    const consumerList = consumers.get(route.handlerId) ?? [];
    results.push({
      route: route.handlerName,
      method: route.method,
      path: route.path,
      handlerId: route.handlerId,
      handlerName: route.handlerName,
      consumers: consumerList,
      isOrphaned: consumerList.length === 0,
      middleware: route.middleware,
    });
  }

  return results;
}

// ── tool_map ───────────────────────────────────────────────────────────────

export function toolMap(graph: KnowledgeGraph): ToolMapEntry[] {
  const toolNodes: Map<string, { name: string; type: string }> = new Map();

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Tool') continue;
    toolNodes.set(node.id, {
      name: (node.properties.name as string) ?? node.id,
      type: (node.properties.toolType as string) ?? '?',
    });
  }

  const callers = new Map<string, Array<{ id: string; name: string; filePath: string }>>();

  // #334: Pre-build handler-to-tool and tool-to-handler indices for O(1) lookup
  const handlerToTool = new Map<string, string>();
  const toolToHandler = new Map<string, string>();
  for (const hr of graph.iterRelationshipsByType('HANDLES_TOOL')) {
    handlerToTool.set(hr.sourceId, hr.targetId);
    toolToHandler.set(hr.targetId, hr.sourceId);
  }

  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    const calleeId = rel.targetId;

    // O(1): Check if callee is a tool handler
    const toolId = handlerToTool.get(calleeId);
    if (toolId && toolNodes.has(toolId)) {
      const caller = graph.getNode(rel.sourceId);
      if (caller) {
        const entry = callers.get(toolId) ?? [];
        entry.push({
          id: caller.id,
          name: (caller.properties.name as string) ?? caller.id,
          filePath: (caller.properties.filePath as string) ?? '?',
        });
        callers.set(toolId, entry);
      }
    }
  }

  const results: ToolMapEntry[] = [];
  for (const [toolId, tool] of toolNodes) {
    const handlerId = toolToHandler.get(toolId) ?? toolId;
    let handlerName = tool.name;
    if (handlerId !== toolId) {
      const handler = graph.getNode(handlerId);
      if (handler) handlerName = (handler.properties.name as string) ?? handlerId;
    }

    const callerList = callers.get(toolId) ?? [];
    results.push({
      toolName: tool.name,
      toolType: tool.type,
      handlerId,
      handlerName,
      callers: callerList,
      isUnused: callerList.length === 0,
    });
  }

  return results;
}

// ── api_impact ─────────────────────────────────────────────────────────────

export async function apiImpact(graph: KnowledgeGraph, symbolName: string, repoPath?: string): Promise<ApiImpactResult[]> {
  // #335: Find ALL matching symbols, not just the first
  const targetIds: string[] = [];
  for (const node of graph.iterNodes()) {
    if (node.properties.name === symbolName) {
      targetIds.push(node.id);
    }
  }
  if (targetIds.length === 0) return [];

  // #411: Pre-build indices ONCE — O(R) instead of O(T×N×R×C)
  const targetIdSet = new Set(targetIds);

  // handler → routes it handles (with middleware)
  const handlerToRoutes = new Map<string, Array<{ method: string; path: string; middleware: string[] }>>();
  for (const hr of graph.iterRelationshipsByType('HANDLES_ROUTE')) {
    if (!targetIdSet.has(hr.sourceId)) continue;
    const routeNode = graph.getNode(hr.targetId);
    if (!routeNode || routeNode.label !== 'Route') continue;
    let arr = handlerToRoutes.get(hr.sourceId);
    if (!arr) { arr = []; handlerToRoutes.set(hr.sourceId, arr); }
    arr.push({
      method: (routeNode.properties.method as string) ?? '?',
      path: (routeNode.properties.path as string) ?? '?',
      middleware: (routeNode.properties.middleware as string[]) ?? [],
    });
  }

  // handler → tools it handles
  const handlerToTools = new Map<string, Array<{ type: string; name: string }>>();
  for (const hr of graph.iterRelationshipsByType('HANDLES_TOOL')) {
    if (!targetIdSet.has(hr.sourceId)) continue;
    const toolNode = graph.getNode(hr.targetId);
    if (!toolNode || toolNode.label !== 'Tool') continue;
    let arr = handlerToTools.get(hr.sourceId);
    if (!arr) { arr = []; handlerToTools.set(hr.sourceId, arr); }
    arr.push({
      type: (toolNode.properties.toolType as string) ?? '?',
      name: (toolNode.properties.name as string) ?? toolNode.id,
    });
  }

  // callee → callers (CALLS relationships) + pre-index: which nodes
  // participate in ANY CALLS edge (for untraceable detection — #694)
  const calleeToCallers = new Map<string, string[]>();
  const nodesWithCallsEdges = new Set<string>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    nodesWithCallsEdges.add(rel.sourceId);
    nodesWithCallsEdges.add(rel.targetId);
    const caller = graph.getNode(rel.sourceId);
    if (!caller) continue;
    let arr = calleeToCallers.get(rel.targetId);
    if (!arr) { arr = []; calleeToCallers.set(rel.targetId, arr); }
    arr.push((caller.properties.name as string) ?? caller.id);
  }

  // Build results using pre-built indices — O(T) lookups
  const results: ApiImpactResult[] = [];
  for (const targetId of targetIds) {
    const routes: ApiImpactResult['routes'] = [];
    const matchedRoutes = handlerToRoutes.get(targetId) ?? [];
    const consumers = calleeToCallers.get(targetId) ?? [];

    // #643 Pitfall 4: When a handler has routes but no consumers,
    // check if the symbol participates in any CALLS edges at all.
    // If it does, the call graph is incomplete → UNKNOWN, not safe.
    let routeRisk: string;
    if (consumers.length > 0) {
      routeRisk = 'BREAKING: has consumers';
    } else {
      routeRisk = nodesWithCallsEdges.has(targetId) ? 'UNKNOWN: untraceable callers' : 'safe to change';
    }

    for (const r of matchedRoutes) {
      routes.push({
        method: r.method,
        path: r.path,
        consumers,
        risk: routeRisk,
        middleware: r.middleware,
      });
    }

    const tools: ApiImpactResult['tools'] = [];
    const matchedTools = handlerToTools.get(targetId) ?? [];
    for (const t of matchedTools) {
      tools.push(t);
    }

    // Collect shape drift from route response shape analysis
    const shapeDrift: ApiImpactResult['shapeDrift'] = [];
    for (const r of matchedRoutes) {
      const mismatches = await shapeCheck(graph, r.path, repoPath);
      for (const m of mismatches) {
        shapeDrift.push({
          field: `${r.method} ${r.path}: ${m.field}`,
          severity: m.severity,
        });
      }
    }

    results.push({
      symbol: `${symbolName} (${targetId})`,
      routes,
      tools,
      shapeDrift,
    });
  }

  return results;
}

// ── Consumer field access extraction ────────────────────────────────────────

// Lazy imports for file I/O (only loaded when repoPath is provided)
let _readFileFn: ((path: string, encoding: string) => Promise<string>) | undefined;
let _joinPathFn: ((...parts: string[]) => string) | undefined;

function getReadFile(): (path: string, encoding: string) => Promise<string> {
  if (!_readFileFn) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _readFileFn = require('node:fs/promises').readFile;
  }
  return _readFileFn!;
}
function getJoinPath(): (...parts: string[]) => string {
  if (!_joinPathFn) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _joinPathFn = require('node:path').join;
  }
  return _joinPathFn!;
}

/**
 * Variable names commonly used to hold HTTP response data after fetch/axios calls.
 * We scan for member access on these identifiers to detect what fields consumers read.
 */
const RESPONSE_VAR_NAMES = new Set([
  'data', 'response', 'json', 'result', 'body', 'res', 'resp',
  'apiResponse', 'responseData', 'r', 'd',
]);

/**
 * Extract field names accessed on HTTP response variables in consumer code.
 *
 * Detects patterns like `data.field`, `response['field']`, `result?.field`,
 * `data.field.subfield` (captures top-level: `field`), destructuring
 * like `const { id, name } = data`, and `data?.field`.
 *
 * Returns deduplicated list of top-level field names.
 */
export function extractConsumerAccessedFields(code: string): string[] {
  const fields = new Set<string>();

  // Pattern 1: dot access or optional chaining on response vars — data.field, response?.field
  const dotPattern = /([$\w]+)\?\.(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = dotPattern.exec(code)) !== null) {
    if (RESPONSE_VAR_NAMES.has(m[1]!)) {
      fields.add(m[2]!);
    }
  }

  // Pattern 2: plain dot access — data.field (not optional chaining)
  // We need to avoid re-matching optional chaining, so use a lookbehind-free approach
  // Match identifier.field where identifier is not preceded by ?.
  const plainDotPattern = /([$\w]+)\.(\w+)/g;
  while ((m = plainDotPattern.exec(code)) !== null) {
    // Avoid optional chaining (already handled above)
    if (code[m.index - 1] === '?') continue;
    // Avoid matching numbers (e.g., 3.14)
    if (/^\d/.test(m[1]!)) continue;
    if (RESPONSE_VAR_NAMES.has(m[1]!)) {
      fields.add(m[2]!);
    }
  }

  // Pattern 3: bracket access — data['field'] or data["field"]
  const bracketPattern = /([$\w]+)\s*\[(['"])([^'"]+)\2\]/g;
  while ((m = bracketPattern.exec(code)) !== null) {
    if (RESPONSE_VAR_NAMES.has(m[1]!)) {
      fields.add(m[3]!);
    }
  }

  // Pattern 4: destructuring — const { id, name } = data or const { id, name } = await data
  const destructPattern = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:await\s+)?(\w+)/g;
  while ((m = destructPattern.exec(code)) !== null) {
    const varName = m[2];
    if (!varName || !RESPONSE_VAR_NAMES.has(varName)) continue;
    const fieldsText = m[1]!;
    const parts = fieldsText.split(',');
    for (const part of parts) {
      const fieldName = part.trim().split(':')[0]?.trim();
      if (fieldName && /^\w+$/.test(fieldName) && !RESPONSE_VAR_NAMES.has(fieldName)) {
        fields.add(fieldName);
      }
    }
  }

  return Array.from(fields);
}

// ── shape_check ────────────────────────────────────────────────────────────

export interface ShapeMismatch {
  field: string;
  severity: 'missing' | 'unused' | 'warning';
  reason: string;
}

export async function shapeCheck(
  graph: KnowledgeGraph,
  routePath: string,
  repoPath?: string,
): Promise<ShapeMismatch[]> {
  // Find the route node by path
  let routeNode = null;
  for (const node of graph.iterNodes()) {
    if (node.label === 'Route' && (node.properties.path as string) === routePath) {
      routeNode = node;
      break;
    }
  }
  if (!routeNode) return [];

  // Provider response keys: what the API actually returns
  const providerKeys = (nodeProperties(routeNode, 'responseKeys') as string[]) ?? [];
  const providerErrorKeys = (nodeProperties(routeNode, 'errorKeys') as string[]) ?? [];
  const allProviderKeys = [...providerKeys, ...providerErrorKeys];

  // Find consumers via FETCHES edges (source = consumer, target = route)
  const consumerFns = new Map<string, { filePath: string; startLine: number; endLine: number; name: string }>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'FETCHES' && rel.targetId === routeNode.id) {
      const consumer = graph.getNode(rel.sourceId);
      if (consumer && (consumer.label === 'Function' || consumer.label === 'Method')) {
        consumerFns.set(consumer.id, {
          filePath: (consumer.properties.filePath as string) ?? '',
          startLine: (consumer.properties.startLine as number) ?? 0,
          endLine: (consumer.properties.endLine as number) ?? Infinity,
          name: (consumer.properties.name as string) ?? consumer.id,
        });
      }
    }
  }

  const mismatches: ShapeMismatch[] = [];

  // Extract consumer-accessed fields from source code
  const allAccessedFields = new Set<string>();
  const consumerFieldMap = new Map<string, Set<string>>();

  if (repoPath && consumerFns.size > 0) {
    // Group consumers by file for batched reads
    const consumersByFile = new Map<string, Array<{ filePath: string; startLine: number; endLine: number; name: string }>>();
    for (const [, fn] of consumerFns) {
      const fns = consumersByFile.get(fn.filePath) ?? [];
      fns.push(fn);
      consumersByFile.set(fn.filePath, fns);
    }

    const readFile = getReadFile();
    const joinPath = getJoinPath();

    for (const [fp, fns] of consumersByFile) {
      let content: string;
      try {
        content = await readFile(joinPath(repoPath, fp), 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split('\n');

      for (const fn of fns) {
        const start = Math.max(0, fn.startLine - 1);
        const end = fn.endLine === Infinity ? lines.length : Math.min(lines.length, fn.endLine);
        const body = lines.slice(start, end).join('\n');
        const accessedFields = extractConsumerAccessedFields(body);
        consumerFieldMap.set(fn.name, new Set(accessedFields));
        for (const f of accessedFields) {
          allAccessedFields.add(f);
        }
      }
    }
  }

  // Comparison 1: Fields consumer accesses but provider doesn't return → missing
  if (allProviderKeys.length > 0) {
    for (const field of allAccessedFields) {
      if (!allProviderKeys.includes(field)) {
        const consumerNames = Array.from(consumerFieldMap.entries())
          .filter(([, fields]) => fields.has(field))
          .map(([name]) => name);
        mismatches.push({
          field,
          severity: 'missing',
          reason: consumerNames.length > 0
            ? `Consumer(s) ${consumerNames.join(', ')} read "${field}" but route does not return it`
            : `Consumer reads "${field}" but route does not return it`,
        });
      }
    }
  }

  // Comparison 2: Fields provider returns but no consumer accesses → unused
  if (allAccessedFields.size > 0) {
    for (const field of providerKeys) {
      if (!allAccessedFields.has(field)) {
        mismatches.push({
          field,
          severity: 'unused',
          reason: `Route returns "${field}" but no consumer reads it`,
        });
      }
    }
  } else if (providerKeys.length > 0 && consumerFns.size > 0 && !repoPath) {
    // Can't extract consumer fields (no repoPath) but there are consumers
    for (const field of providerKeys) {
      mismatches.push({
        field,
        severity: 'warning',
        reason: `Route returns "${field}" — unable to verify consumer access (needs repo path)`,
      });
    }
  }

  // Also flag error-only response fields when there are consumers
  if (providerKeys.length === 0 && providerErrorKeys.length > 0 && consumerFns.size > 0) {
    for (const field of providerErrorKeys) {
      mismatches.push({
        field,
        severity: 'warning',
        reason: `Error response field "${field}" returned by route`,
      });
    }
  }

  return mismatches.slice(0, 30);
}

function nodeProperties(node: { properties: Record<string, unknown> }, key: string): unknown {
  return node.properties[key];
}
