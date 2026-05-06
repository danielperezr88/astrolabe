/**
 * Pipeline Phase: Tool/Handler Detection
 *
 * Reads actual source files to detect MCP tools, tRPC routers, gRPC services,
 * and CLI commands by scanning file contents (#138).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import { createLogger } from '../../logging/index.js';

const log = createLogger({ level: 'debug' });

export interface ToolsOutput { toolCount: number; toolTypes: string[]; }

const PATTERNS: Array<{ type: string; regex: RegExp; nameGroup: number; protoOnly?: boolean }> = [
  { type: 'mcp', regex: /server\.tool\s*\(\s*['"]([^'"]+)['"]/g, nameGroup: 1 },
  { type: 'trpc', regex: /\.(query|mutation|procedure)\s*\(\s*['"]([^'"]+)['"]?/g, nameGroup: 2 },
  { type: 'cli', regex: /\.command\s*\(\s*['"]([^'"]+)['"]/g, nameGroup: 1 },
  { type: 'grpc', regex: /\brpc\s+(\w+)\s*\(/g, nameGroup: 1, protoOnly: true },
];

export const toolsPhase: PhaseDefinition<ToolsOutput> = {
  name: 'tools', dependencies: ['parse-emit'],

  async execute(context: PhaseContext): Promise<ToolsOutput> {
    const { graph } = context;
    let toolCount = 0;
    const toolTypes = new Set<string>();

    // #280: Support incremental indexing — only process changed/added files
    const changedPaths = context.state.get('incremental:changedPaths') as Set<string> | undefined;

    for (const node of graph.iterNodes()) {
      if (node.label !== 'File') continue;
      const fp = node.properties.filePath as string | undefined;
      if (!fp) continue;
      if (changedPaths && !changedPaths.has(fp)) continue;

      try {
        const content = await readFile(join(context.repoPath, fp), 'utf-8');
        for (const pat of PATTERNS) {
          // Skip proto-only patterns for non-.proto files (#185)
          if (pat.protoOnly && !fp.endsWith('.proto')) continue;
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
      } catch (err) { log.debug('Skipping unreadable file in tool detection', { file: fp, error: String(err) }); }
    }
    return { toolCount, toolTypes: Array.from(toolTypes) };
  },
};
