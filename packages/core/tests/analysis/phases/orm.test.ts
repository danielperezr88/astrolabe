/**
 * Tests for the ORM pipeline phase — Supabase, SQLAlchemy, TypeORM,
 * Sequelize, Mongoose, Prisma, and Django detection (#634).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { ormPhase } from '../../../src/analysis/phases/orm.js';
import type { OrmOutput } from '../../../src/analysis/phases/orm.js';
import { createPhaseContext, runPipeline } from '../../../src/core/pipeline.js';
import { createKnowledgeGraph } from '../../../src/core/graph.js';

function makeRepo(fixtures: Record<string, string>): string {
  const tmp = mkdtempSync(join(tmpdir(), 'astrolabe-orm-'));
  for (const [path, content] of Object.entries(fixtures)) {
    const fullPath = join(tmp, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return tmp;
}

// ── Supabase detection (#634) ────────────────────────────────────────────────

describe('ORM Phase', () => {
  describe('Supabase detection', () => {
    it('detects Supabase client imports and .from() queries', async () => {
      const repo = makeRepo({
        'src/db.ts': `
          import { createClient } from '@supabase/supabase-js';
          const supabase = createClient('https://example.supabase.co', 'key');
          const { data } = await supabase.from('users').select('*');
          const { result } = await supabase.from('orders').select('*');
        `,
      });

      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'import:0',
        label: 'Import',
        properties: { name: '@supabase/supabase-js', filePath: 'src/db.ts' },
      });
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([ormPhase], context))[0] as OrmOutput;

      expect(output.frameworks).toContain('supabase');
      expect(output.modelCount).toBeGreaterThanOrEqual(2); // at least 'users' and 'orders' tables

      const supaNodes = graph.findNodesByLabel('CodeElement').filter(n => n.properties.orm === 'supabase');
      expect(supaNodes.length).toBeGreaterThanOrEqual(2);

      rmSync(repo, { recursive: true, force: true });
    });

    it('detects Supabase .rpc() calls', async () => {
      const repo = makeRepo({
        'src/api.ts': `
          import { createClient } from '@supabase/supabase-js';
          const supabase = createClient('url', 'key');
          const { data } = await supabase.rpc('get_stats', { year: 2024 });
        `,
      });

      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'import:1',
        label: 'Import',
        properties: { name: '@supabase/supabase-js', filePath: 'src/api.ts' },
      });
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([ormPhase], context))[0] as OrmOutput;

      expect(output.frameworks).toContain('supabase');
      const rpcNodes = graph.findNodesByLabel('CodeElement').filter(n => n.properties.kind === 'rpc' && n.properties.orm === 'supabase');
      expect(rpcNodes.length).toBeGreaterThanOrEqual(1);
      expect(rpcNodes[0]?.properties.name).toBe('get_stats');

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── SQLAlchemy detection (#634) ──────────────────────────────────────────

  describe('SQLAlchemy detection', () => {
    it('detects SQLAlchemy model classes', async () => {
      const repo = makeRepo({
        'models/user.py': `
from sqlalchemy import Column, Integer, String
from sqlalchemy.ext.declarative import declarative_base
Base = declarative_base()

class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True)
    name = Column(String)
`,
      });

      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'import:sqla',
        label: 'Import',
        properties: { name: 'sqlalchemy', filePath: 'models/user.py' },
      });
      graph.addNode({
        id: 'class:User',
        label: 'Class',
        properties: { name: 'User', filePath: 'models/user.py' },
      });
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([ormPhase], context))[0] as OrmOutput;

      expect(output.frameworks).toContain('sqlalchemy');
      const sqlaNodes = graph.findNodesByLabel('CodeElement').filter(n => n.properties.orm === 'sqlalchemy');
      expect(sqlaNodes.length).toBeGreaterThanOrEqual(1);
      expect(sqlaNodes.some(n => n.properties.name === 'User')).toBe(true);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── TypeORM detection (#634) ────────────────────────────────────────────

  describe('TypeORM detection', () => {
    it('detects TypeORM @Entity decorators and BaseEntity classes', async () => {
      const repo = makeRepo({
        'src/entity/Product.ts': `
import { Entity, PrimaryGeneratedColumn, Column, BaseEntity } from 'typeorm';

@Entity('products')
export class Product extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;
}
`,
      });

      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'import:typeorm',
        label: 'Import',
        properties: { name: 'typeorm', filePath: 'src/entity/Product.ts' },
      });
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([ormPhase], context))[0] as OrmOutput;

      expect(output.frameworks).toContain('typeorm');
      const typeormNodes = graph.findNodesByLabel('CodeElement').filter(n => n.properties.orm === 'typeorm');
      expect(typeormNodes.length).toBeGreaterThanOrEqual(1);
      // Should detect 'products' entity and/or 'Product' BaseEntity class
      expect(typeormNodes.some(n => n.properties.name === 'products' || n.properties.name === 'Product')).toBe(true);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── Sequelize detection (#634) ──────────────────────────────────────────

  describe('Sequelize detection', () => {
    it('detects sequelize.define() model definitions', async () => {
      const repo = makeRepo({
        'models/index.js': `
const { Sequelize, DataTypes } = require('sequelize');
const sequelize = new Sequelize('db', 'user', 'pass');

const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true },
  name: { type: DataTypes.STRING },
});
`,
      });

      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'import:seq',
        label: 'Import',
        properties: { name: 'sequelize', filePath: 'models/index.js' },
      });
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([ormPhase], context))[0] as OrmOutput;

      expect(output.frameworks).toContain('sequelize');
      const seqNodes = graph.findNodesByLabel('CodeElement').filter(n => n.properties.orm === 'sequelize');
      expect(seqNodes.length).toBeGreaterThanOrEqual(1);
      expect(seqNodes.some(n => n.properties.name === 'User')).toBe(true);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── Mongoose detection (#634) ────────────────────────────────────────────

  describe('Mongoose detection', () => {
    it('detects mongoose.model() and new Schema() patterns', async () => {
      const repo = makeRepo({
        'models/product.js': `
const mongoose = require('mongoose');
const productSchema = new mongoose.Schema({
  name: String,
  price: Number,
});
const Product = mongoose.model('Product', productSchema);
`,
      });

      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'import:mongoose',
        label: 'Import',
        properties: { name: 'mongoose', filePath: 'models/product.js' },
      });
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([ormPhase], context))[0] as OrmOutput;

      expect(output.frameworks).toContain('mongoose');
      const mgNodes = graph.findNodesByLabel('CodeElement').filter(n => n.properties.orm === 'mongoose');
      expect(mgNodes.length).toBeGreaterThanOrEqual(1);
      // Should detect 'Product' model from mongoose.model() or Schema
      expect(mgNodes.some(n => n.properties.name === 'Product' || n.properties.name === 'Schema')).toBe(true);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── Prisma detection (existing — regression check) ─────────────────────────

  describe('Prisma detection (existing)', () => {
    it('detects Prisma schema models', async () => {
      const repo = makeRepo({
        'prisma/schema.prisma': `
model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
}
`,
      });

      const graph = createKnowledgeGraph();
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([ormPhase], context))[0] as OrmOutput;

      expect(output.frameworks).toContain('prisma');
      expect(output.modelCount).toBeGreaterThanOrEqual(1);

      rmSync(repo, { recursive: true, force: true });
    });
  });

  // ── Django detection (existing — regression check) ─────────────────────────

  describe('Django detection (existing)', () => {
    it('detects Django models in models.py', async () => {
      const repo = makeRepo({});

      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'class:Article',
        label: 'Class',
        properties: { name: 'Article', filePath: 'myapp/models.py' },
      });
      const context = createPhaseContext(repo, graph, () => {});
      const output = (await runPipeline([ormPhase], context))[0] as OrmOutput;

      expect(output.frameworks).toContain('django');

      rmSync(repo, { recursive: true, force: true });
    });
  });
});