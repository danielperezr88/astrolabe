/**
 * Pipeline Phase: Tool/Handler Detection
 *
 * Detects MCP tool definitions, tRPC routers, gRPC services, and
 * CLI command handlers. Creates Tool nodes with HANDLES_TOOL edges.
 *
 * Dependencies: parse-emit
 * Output: Tool nodes + HANDLES_TOOL edges
 */

import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

export interface ToolsOutput {
  toolCount: number;
  toolTypes: string[];
}

export const toolsPhase: PhaseDefinition<ToolsOutput> = {
  name: 'tools',
  dependencies: ['parse-emit'],

  execute(context: PhaseContext): ToolsOutput {
    const { graph } = context;
    let toolCount = 0;
    const toolTypes = new Set<string>();

    for (const node of graph.iterNodes()) {
      const fp = node.properties.filePath as string | undefined;
      const name = node.properties.name as string | undefined;
      if (!fp || !name) continue;

      // CLI command: commander/yargs command handlers
      if (/\.command\s*\(/.test(name) || /\.action\s*\(/.test(name)) {
        createTool(`cli:${fp}:${name}`, 'cli', name, fp);
        toolTypes.add('cli');
        toolCount++;
      }

      // tRPC router procedures
      if (node.label === 'Function' && /\.query\(|\.mutation\(|\.procedure\(/.test(name)) {
        createTool(`trpc:${fp}:${name}`, 'trpc', name, fp);
        toolTypes.add('trpc');
        toolCount++;
      }

      // MCP tool definitions
      if (node.label === 'Function' && /server\.tool\(/.test(name)) {
        createTool(`mcp:${fp}:${name}`, 'mcp', name, fp);
        toolTypes.add('mcp');
        toolCount++;
      }

      // gRPC handler functions
      if (node.label === 'Function' && /rpc\s+\w+|Handle\w+|Serve\w+/.test(name)) {
        createTool(`grpc:${fp}:${name}`, 'grpc', name, fp);
        toolTypes.add('grpc');
        toolCount++;
      }
    }

    function createTool(id: string, toolType: string, name: string, filePath: string) {
      if (graph.getNode(id)) return;
      graph.addNode({
        id,
        label: 'Tool',
        properties: { name, filePath, toolType },
      });

      // Find the file node to create HANDLES_TOOL edge
      for (const fileNode of graph.iterNodes()) {
        if (fileNode.label === 'File' && fileNode.properties.filePath === filePath) {
          graph.addRelationship({
            id: `tool:${id}:file:${fileNode.id}`,
            sourceId: fileNode.id,
            targetId: id,
            type: 'HANDLES_TOOL',
            confidence: 0.6,
            reason: `${toolType} tool detected from symbol ${name}`,
          });
          break;
        }
      }
    }

    return { toolCount, toolTypes: Array.from(toolTypes) };
  },
};
