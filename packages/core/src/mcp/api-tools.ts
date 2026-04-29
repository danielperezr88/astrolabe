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
  routes: Array<{ method: string; path: string; consumers: string[]; risk: string }>;
  tools: Array<{ type: string; name: string }>;
  shapeDrift: Array<{ field: string; severity: string }>;
}

// ── route_map ──────────────────────────────────────────────────────────────

export function routeMap(graph: KnowledgeGraph): RouteMapEntry[] {
  const routeNodes: Map<string, { method: string; path: string; handlerId: string; handlerName: string }> = new Map();

  // Collect Route nodes
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Route') continue;
    routeNodes.set(node.id, {
      method: (node.properties.method as string) ?? '?',
      path: (node.properties.path as string) ?? '?',
      handlerId: node.id,
      handlerName: (node.properties.name as string) ?? node.id,
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

  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    const calleeId = rel.targetId;

    // Check if the callee is a tool handler
    for (const [toolId] of toolNodes) {
      // Find HANDLES_TOOL edge linking handler → tool
      const handlesRel = graph.iterRelationshipsByType('HANDLES_TOOL');
      for (const hr of handlesRel) {
        if (hr.targetId === toolId && hr.sourceId === calleeId) {
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
    }
  }

  const results: ToolMapEntry[] = [];
  for (const [toolId, tool] of toolNodes) {
    const handlerRel = graph.iterRelationshipsByType('HANDLES_TOOL');
    let handlerId = toolId;
    let handlerName = tool.name;
    for (const hr of handlerRel) {
      if (hr.targetId === toolId) {
        handlerId = hr.sourceId;
        const handler = graph.getNode(hr.sourceId);
        if (handler) handlerName = (handler.properties.name as string) ?? handlerId;
      }
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

export function apiImpact(graph: KnowledgeGraph, symbolName: string): ApiImpactResult[] {
  // #335: Find ALL matching symbols, not just the first
  const targetIds: string[] = [];
  for (const node of graph.iterNodes()) {
    if (node.properties.name === symbolName) {
      targetIds.push(node.id);
    }
  }
  if (targetIds.length === 0) return [];

  const results: ApiImpactResult[] = [];

  for (const targetId of targetIds) {
    // Find related routes
    const routes: ApiImpactResult['routes'] = [];
    for (const node of graph.iterNodes()) {
      if (node.label !== 'Route') continue;
      const handlesRel = graph.iterRelationshipsByType('HANDLES_ROUTE');
      for (const hr of handlesRel) {
        if (hr.targetId === node.id && hr.sourceId === targetId) {
          const consumers: string[] = [];
          for (const rel of graph.iterRelationships()) {
            if (rel.type === 'CALLS' && rel.targetId === targetId) {
              const caller = graph.getNode(rel.sourceId);
              if (caller) consumers.push((caller.properties.name as string) ?? caller.id);
            }
          }
          routes.push({
            method: (node.properties.method as string) ?? '?',
            path: (node.properties.path as string) ?? '?',
            consumers,
            risk: consumers.length > 0 ? 'BREAKING: has consumers' : 'safe to change',
          });
        }
      }
    }

    // Find related tools
    const tools: ApiImpactResult['tools'] = [];
    for (const node of graph.iterNodes()) {
      if (node.label !== 'Tool') continue;
      const handlesRel = graph.iterRelationshipsByType('HANDLES_TOOL');
      for (const hr of handlesRel) {
        if (hr.targetId === node.id && hr.sourceId === targetId) {
          tools.push({
            type: (node.properties.toolType as string) ?? '?',
            name: (node.properties.name as string) ?? node.id,
          });
        }
      }
    }

    results.push({
      symbol: `${symbolName} (${targetId})`,
      routes,
      tools,
      shapeDrift: [],
    });
  }

  return results;
}

// ── shape_check ────────────────────────────────────────────────────────────

export function shapeCheck(graph: KnowledgeGraph, routePath: string): Array<{ field: string; severity: string }> {
  // Find the route
  let routeNode = null;
  for (const node of graph.iterNodes()) {
    if (node.label === 'Route' && (node.properties.path as string) === routePath) {
      routeNode = node;
      break;
    }
  }
  if (!routeNode) return [];

  const mismatches: Array<{ field: string; severity: string }> = [];

  // Check consumers of this route
  const handlesRel = graph.iterRelationshipsByType('HANDLES_ROUTE');
  let handlerId = '';
  for (const hr of handlesRel) {
    if (hr.targetId === routeNode!.id) {
      handlerId = hr.sourceId;
    }
  }

  if (!handlerId) return mismatches;

  // Find callers of the handler
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'CALLS' && rel.targetId === handlerId) {
      const caller = graph.getNode(rel.sourceId);
      if (!caller) continue;

      // Check for USES edges from caller to types/imports that indicate field access
      for (const rel2 of graph.iterRelationships()) {
        if (rel2.type === 'USES' && rel2.sourceId === caller.id) {
          const usedNode = graph.getNode(rel2.targetId);
          if (usedNode && usedNode.label === 'Variable') {
            mismatches.push({
              field: (usedNode.properties.name as string) ?? usedNode.id,
              severity: 'warning',
            });
          }
        }
      }
    }
  }

  return mismatches.slice(0, 20);
}
