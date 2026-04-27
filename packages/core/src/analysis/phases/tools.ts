/**
 * Pipeline Phase: Tool/Handler Detection
 *
 * Reads actual source files to detect MCP tools, tRPC routers, gRPC services,
 * and CLI commands by scanning file contents (#138).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

export interface ToolsOutput { toolCount: number; toolTypes: string[]; }

const PATTERNS: Array<{ type: string; regex: RegExp; nameGroup: number }> = [
  { type: 'mcp', regex: /server\.tool\s*\(\s*['"]([^'"]+)['"]/g, nameGroup: 1 },
  { type: 'trpc', regex: /\.(query|mutation|procedure)\s*\(\s*['"]([^'"]+)['"]?/g, nameGroup: 0 },
  { type: 'cli', regex: /\.command\s*\(\s*['"]([^'"]+)['"]/g, nameGroup: 1 },
  { type: 'grpc', regex: /\brpc\s+(\w+)\s*\(/g, nameGroup: 1 },
];

export const toolsPhase: PhaseDefinition<ToolsOutput> = {
  name: 'tools', dependencies: ['parse-emit'],

  execute(context: PhaseContext): ToolsOutput {
    const { graph } = context;
    let toolCount = 0;
    const toolTypes = new Set<string>();

    for (const node of graph.iterNodes()) {
      if (node.label !== 'File') continue;
      const fp = node.properties.filePath as string | undefined;
      if (!fp) continue;

      try {
        const content = readFileSync(join(context.repoPath, fp), 'utf-8');
        for (const pat of PATTERNS) {
          let match;
          while ((match = pat.regex.exec(content)) !== null) {
            const toolName = pat.nameGroup ? match[pat.nameGroup] : match[0];
            const toolId = `tool:${fp}:${pat.type}:${toolName}`;
            if (graph.getNode(toolId)) continue;

            graph.addNode({
              id: toolId, label: 'Tool',
              properties: { name: toolName, filePath: fp, toolType: pat.type },
            });
            graph.addRelationship({
              id: `tool:file:${toolId}:${node.id}`, sourceId: node.id, targetId: toolId,
              type: 'HANDLES_TOOL', confidence: 0.6,
              reason: `${pat.type} tool ${toolName} detected in ${fp}`,
            });
            toolCount++; toolTypes.add(pat.type);
          }
        }
      } catch { /* skip unreadable */ }
    }
    return { toolCount, toolTypes: Array.from(toolTypes) };
  },
};
