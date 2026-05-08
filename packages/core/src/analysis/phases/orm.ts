/**
 * Pipeline Phase: ORM Query Detection
 *
 * Detects ORM model references and query patterns by analyzing
 * symbol names and file contents for common ORM patterns.
 * Extended with Supabase client, SQLAlchemy, TypeORM, Sequelize,
 * and Mongoose model detection (#634).
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

    // #634: Track files with ORM imports for content scanning
    const supabaseImportFiles = new Set<string>();
    const sqlalchemyImportFiles = new Set<string>();
    const typeormImportFiles = new Set<string>();
    const sequelizeImportFiles = new Set<string>();
    const mongooseImportFiles = new Set<string>();

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

      // Supabase import — track files for deeper scanning (#634)
      if (source.includes('@supabase/supabase-js')) {
        frameworks.add('supabase');
        const fp = node.properties.filePath as string | undefined;
        if (fp) supabaseImportFiles.add(fp);

        const prismaNodeId = `orm:supabase:import:${node.id}`;
        if (!graph.getNode(prismaNodeId)) {
          graph.addNode({
            id: prismaNodeId,
            label: 'CodeElement',
            properties: { name: 'SupabaseClient', filePath: fp ?? '', kind: 'client', orm: 'supabase' },
          });
          graph.addRelationship({
            id: `orm:uses:${node.id}:supabase`,
            sourceId: node.id,
            targetId: prismaNodeId,
            type: 'USES',
            confidence: 0.8,
            reason: 'Import of @supabase/supabase-js',
          });
          queryEdgeCount++;
        }
      }

      // SQLAlchemy / flask_sqlalchemy import — track files for model scanning (#634)
      if (source.includes('sqlalchemy') || source.includes('flask_sqlalchemy')) {
        frameworks.add('sqlalchemy');
        const fp = node.properties.filePath as string | undefined;
        if (fp) sqlalchemyImportFiles.add(fp);
      }

      // TypeORM import — track files for entity scanning (#634)
      if (source.includes('typeorm')) {
        frameworks.add('typeorm');
        const fp = node.properties.filePath as string | undefined;
        if (fp) typeormImportFiles.add(fp);
      }

      // Sequelize import — track files for model scanning (#634)
      if (source.includes('sequelize')) {
        frameworks.add('sequelize');
        const fp = node.properties.filePath as string | undefined;
        if (fp) sequelizeImportFiles.add(fp);
      }

      // Mongoose import — track files for model/schema scanning (#634)
      if (source.includes('mongoose') && !source.includes('mongoose-')) {
        frameworks.add('mongoose');
        const fp = node.properties.filePath as string | undefined;
        if (fp) mongooseImportFiles.add(fp);
      }
    }

    // ── Content-based detection for tracked ORM imports (#634) ────────────────
    const contentCache = new Map<string, string>();
    const readFileCached = async (fp: string): Promise<string | undefined> => {
      if (contentCache.has(fp)) {
        const cached = contentCache.get(fp)!;
        return cached || undefined;
      }
      try {
        const content = await readFile(join(context.repoPath, fp), 'utf-8');
        contentCache.set(fp, content);
        return content;
      } catch {
        contentCache.set(fp, '');
        return undefined;
      }
    };

    // ── Supabase client usage detection (#634) ──────────────────────────────
    const supabaseElementsByFile = new Map<string, string[]>();

    for (const fp of supabaseImportFiles) {
      if (changedPaths && !changedPaths.has(fp)) continue;
      const content = await readFileCached(fp);
      if (!content) continue;

      const elements: string[] = [];

      // createClient() calls
      const createClientPattern = /createClient\s*\(/g;
      if (createClientPattern.test(content)) {
        const clientId = `orm:supabase:client:${fp}`;
        if (!graph.getNode(clientId)) {
          graph.addNode({
            id: clientId,
            label: 'CodeElement',
            properties: { name: 'SupabaseClient', filePath: fp, kind: 'client', orm: 'supabase' },
          });
          modelCount++;
        }
        elements.push(clientId);
      }

      // .from('table') queries
      const fromPattern = /\.from\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = fromPattern.exec(content)) !== null) {
        const tableName = match[1]!;
        const tableId = `orm:supabase:table:${fp}:${tableName}`;
        if (!graph.getNode(tableId)) {
          graph.addNode({
            id: tableId,
            label: 'CodeElement',
            properties: { name: tableName, filePath: fp, kind: 'table', orm: 'supabase' },
          });
          modelCount++;
        }
        elements.push(tableId);
      }

      // .rpc('function') calls
      const rpcPattern = /\.rpc\s*\(\s*['"]([^'"]+)['"]\s*[,)]/g;
      while ((match = rpcPattern.exec(content)) !== null) {
        const rpcName = match[1]!;
        const rpcId = `orm:supabase:rpc:${fp}:${rpcName}`;
        if (!graph.getNode(rpcId)) {
          graph.addNode({
            id: rpcId,
            label: 'CodeElement',
            properties: { name: rpcName, filePath: fp, kind: 'rpc', orm: 'supabase' },
          });
          modelCount++;
        }
        elements.push(rpcId);
      }

      if (elements.length > 0) {
        frameworks.add('supabase');
        supabaseElementsByFile.set(fp, elements);
      }
    }

    // Link Function/Method nodes in supabase files to detected elements
    for (const node of graph.iterNodes()) {
      if (node.label !== 'Function' && node.label !== 'Method') continue;
      const fp = node.properties.filePath as string | undefined;
      if (!fp) continue;
      const elements = supabaseElementsByFile.get(fp);
      if (!elements) continue;

      for (const elementId of elements) {
        const edgeId = `orm:uses:${node.id}:supabase:${elementId}`;
        if (!graph.getRelationship(edgeId)) {
          graph.addRelationship({
            id: edgeId,
            sourceId: node.id,
            targetId: elementId,
            type: 'USES',
            confidence: 0.7,
            reason: 'Function uses Supabase',
          });
          queryEdgeCount++;
        }
      }
    }

    // ── SQLAlchemy model detection (#634) ────────────────────────────────────
    for (const fp of sqlalchemyImportFiles) {
      if (changedPaths && !changedPaths.has(fp)) continue;
      const content = await readFileCached(fp);
      if (!content) continue;

      const sqlalchemyModelPattern = /class\s+(\w+)\s*\([^)]*(?:db\.Model|Base|DeclarativeBase)[^)]*\)/g;
      let match: RegExpExecArray | null;
      while ((match = sqlalchemyModelPattern.exec(content)) !== null) {
        const modelName = match[1]!;
        const modelId = `model:sqlalchemy:${modelName}`;
        if (!graph.getNode(modelId)) {
          graph.addNode({
            id: modelId,
            label: 'CodeElement',
            properties: { name: modelName, filePath: fp, kind: 'model', orm: 'sqlalchemy' },
          });
          modelCount++;
        }
      }
    }

    // ── TypeORM entity detection (#634) ─────────────────────────────────────
    for (const fp of typeormImportFiles) {
      if (changedPaths && !changedPaths.has(fp)) continue;
      const content = await readFileCached(fp);
      if (!content) continue;

      const entityPattern = /@Entity\s*\(\s*['"]?([^'")\s]+)?['"]?\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = entityPattern.exec(content)) !== null) {
        const entityName = match[1] || 'unknown';
        const entityId = `entity:typeorm:${entityName}`;
        if (!graph.getNode(entityId)) {
          graph.addNode({
            id: entityId,
            label: 'CodeElement',
            properties: { name: entityName, filePath: fp, kind: 'entity', orm: 'typeorm' },
          });
          modelCount++;
        }
      }

      const baseEntityPattern = /class\s+(\w+)\s+extends\s+BaseEntity/g;
      while ((match = baseEntityPattern.exec(content)) !== null) {
        const entityName = match[1]!;
        const entityId = `entity:typeorm:${entityName}`;
        if (!graph.getNode(entityId)) {
          graph.addNode({
            id: entityId,
            label: 'CodeElement',
            properties: { name: entityName, filePath: fp, kind: 'entity', orm: 'typeorm' },
          });
          modelCount++;
        }
      }
    }

    // ── Sequelize model detection (#634) ─────────────────────────────────────
    for (const fp of sequelizeImportFiles) {
      if (changedPaths && !changedPaths.has(fp)) continue;
      const content = await readFileCached(fp);
      if (!content) continue;

      const sequelizeDefinePattern = /sequelize\.define\s*\(\s*['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = sequelizeDefinePattern.exec(content)) !== null) {
        const modelName = match[1]!;
        const modelId = `model:sequelize:${modelName}`;
        if (!graph.getNode(modelId)) {
          graph.addNode({
            id: modelId,
            label: 'CodeElement',
            properties: { name: modelName, filePath: fp, kind: 'model', orm: 'sequelize' },
          });
          modelCount++;
        }
      }
    }

    // ── Mongoose model/schema detection (#634) ──────────────────────────────
    for (const fp of mongooseImportFiles) {
      if (changedPaths && !changedPaths.has(fp)) continue;
      const content = await readFileCached(fp);
      if (!content) continue;

      const mongooseModelPattern = /mongoose\.model\s*\(\s*['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = mongooseModelPattern.exec(content)) !== null) {
        const modelName = match[1]!;
        const modelId = `model:mongoose:${modelName}`;
        if (!graph.getNode(modelId)) {
          graph.addNode({
            id: modelId,
            label: 'CodeElement',
            properties: { name: modelName, filePath: fp, kind: 'model', orm: 'mongoose' },
          });
          modelCount++;
        }
      }

      const schemaPattern = /new\s+Schema\s*\(/g;
      if (schemaPattern.test(content)) {
        const schemaId = `orm:mongoose:schema:${fp}`;
        if (!graph.getNode(schemaId)) {
          graph.addNode({
            id: schemaId,
            label: 'CodeElement',
            properties: { name: 'Schema', filePath: fp, kind: 'schema', orm: 'mongoose' },
          });
          modelCount++;
        }
      }
    }

    return { modelCount, queryEdgeCount, frameworks: Array.from(frameworks) };
  },
};
