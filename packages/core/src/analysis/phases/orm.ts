/**
 * Pipeline Phase: ORM Query Detection
 *
 * Detects ORM model references and query patterns by analyzing
 * symbol names and file contents for common ORM patterns.
 *
 * Dependencies: parse-emit
 * Output: CodeElement nodes + USES edges
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import { createLogger } from '../../logging/index.js';

const log = createLogger({ level: 'debug' });

export interface OrmOutput {
  modelCount: number;
  queryEdgeCount: number;
  frameworks: string[];
}

export const ormPhase: PhaseDefinition<OrmOutput> = {
  name: 'orm',
  dependencies: ['parse-emit'],

  async execute(context: PhaseContext): Promise<OrmOutput> {
    const { graph } = context;
    const frameworks = new Set<string>();
    let modelCount = 0;
    let queryEdgeCount = 0;

    // #280: Support incremental indexing — only process changed/added files
    const changedPaths = context.state.get('incremental:changedPaths') as Set<string> | undefined;

    // Detect Prisma schema
    const prismaSchema = join(context.repoPath, 'prisma', 'schema.prisma');
    const prismaChanged = !changedPaths || changedPaths.has('prisma/schema.prisma');
    if (prismaChanged && existsSync(prismaSchema)) {
      try {
        const content = await readFile(prismaSchema, 'utf-8');
        const modelRegex = /model\s+(\w+)\s*\{/g;
        let match;
        while ((match = modelRegex.exec(content)) !== null) {
          const modelName = match[1];
          const modelId = `model:prisma:${modelName}`;
          graph.addNode({
            id: modelId,
            label: 'CodeElement',
            properties: { name: modelName, filePath: 'prisma/schema.prisma', kind: 'model', orm: 'prisma' },
          });
          modelCount++;
        }
        frameworks.add('prisma');
      } catch (err) { log.debug('Skipping unreadable ORM schema file', { file: prismaSchema, error: String(err) }); }
    }

    // Detect Django models
    let djangoModelCount = 0;
    for (const node of graph.iterNodes()) {
      if (node.label !== 'Class') continue;
      const fp = node.properties.filePath as string | undefined;
      if (!fp || !fp.includes('models.py')) continue;
      const name = node.properties.name as string | undefined;
      if (!name) continue;

      const modelId = `model:django:${name}`;
      if (graph.getNode(modelId)) continue;
      graph.addNode({
        id: modelId,
        label: 'CodeElement',
        properties: { name, filePath: fp, kind: 'model', orm: 'django' },
      });
      djangoModelCount++;
    }
    if (djangoModelCount > 0) frameworks.add('django');

    // Detect ORM usage patterns in symbol names
    for (const node of graph.iterNodes()) {
      if (node.label !== 'Import') continue;
      const source = node.properties.name as string | undefined;
      if (!source) continue;

      // Prisma client import
      if (source.includes('@prisma/client')) {
        frameworks.add('prisma');
        const prismaNodeId = `orm:prisma:client:${node.id}`;
        graph.addNode({
          id: prismaNodeId,
          label: 'CodeElement',
          properties: { name: 'PrismaClient', filePath: node.properties.filePath ?? '', kind: 'client', orm: 'prisma' },
        });
        graph.addRelationship({
          id: `orm:uses:${node.id}:prisma`,
          sourceId: node.id,
          targetId: prismaNodeId,
          type: 'USES',
          confidence: 0.8,
          reason: 'Import of @prisma/client',
        });
        queryEdgeCount++;
      }

      // Supabase import
      if (source.includes('@supabase/supabase-js')) {
        frameworks.add('supabase');
      }
    }

    return { modelCount, queryEdgeCount, frameworks: Array.from(frameworks) };
  },
};
