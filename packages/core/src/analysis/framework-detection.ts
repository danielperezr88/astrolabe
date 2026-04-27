/**
 * Framework Detection.
 *
 * Detects which web frameworks, ORMs, and libraries a project uses
 * by analyzing configuration files and source code patterns.
 * Creates Framework nodes with USES_FRAMEWORK edges.
 *
 * Used by: route/ORM/tool phases for accurate pattern matching.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeGraph } from '../core/types.js';

export interface FrameworkInfo {
  name: string;
  ecosystem: string;
  version?: string;
  detectedFrom: string;
}

type FrameworkDetector = (repoPath: string, graph: KnowledgeGraph) => FrameworkInfo[];

// ── JS/TS detectors ────────────────────────────────────────────────────────

function detectJsFrameworks(repoPath: string, _graph: KnowledgeGraph): FrameworkInfo[] {
  const results: FrameworkInfo[] = [];
  const pkgPath = join(repoPath, 'package.json');
  if (!existsSync(pkgPath)) return results;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (!deps) return results;

    const frameworks = [
      { name: 'next', dep: 'next' },
      { name: 'express', dep: 'express' },
      { name: 'fastify', dep: 'fastify' },
      { name: 'koa', dep: 'koa' },
      { name: 'nest', dep: '@nestjs/core' },
      { name: 'remix', dep: '@remix-run/node' },
      { name: 'nuxt', dep: 'nuxt' },
      { name: 'trpc', dep: '@trpc/server' },
    ];
    for (const fw of frameworks) {
      if (deps[fw.dep]) results.push({ name: fw.name, ecosystem: 'javascript', version: deps[fw.dep], detectedFrom: 'package.json' });
    }

    const orms = [
      { name: 'prisma', dep: 'prisma' },
      { name: 'typeorm', dep: 'typeorm' },
      { name: 'sequelize', dep: 'sequelize' },
      { name: 'drizzle', dep: 'drizzle-orm' },
      { name: 'knex', dep: 'knex' },
      { name: 'mongoose', dep: 'mongoose' },
    ];
    for (const orm of orms) {
      if (deps[orm.dep]) results.push({ name: orm.name, ecosystem: 'javascript', version: deps[orm.dep], detectedFrom: 'package.json' });
    }
  } catch { /* skip */ }
  return results;
}

// ── Python detectors ───────────────────────────────────────────────────────

function detectPythonFrameworks(repoPath: string, _graph: KnowledgeGraph): FrameworkInfo[] {
  const results: FrameworkInfo[] = [];

  // Check requirements.txt
  const reqPath = join(repoPath, 'requirements.txt');
  if (existsSync(reqPath)) {
    try {
      const content = readFileSync(reqPath, 'utf-8');
      const lines = content.split('\n');
      const pyFrameworks = ['flask', 'fastapi', 'django', 'aiohttp', 'sanic', 'starlette'];
      const pyOrms = ['sqlalchemy', 'django.db', 'peewee', 'tortoise', 'pony'];
      for (const line of lines) {
        const lowered = line.toLowerCase();
        for (const fw of pyFrameworks) {
          if (lowered.startsWith(fw)) results.push({ name: fw, ecosystem: 'python', detectedFrom: 'requirements.txt' });
        }
        for (const orm of pyOrms) {
          if (lowered.startsWith(orm)) results.push({ name: orm, ecosystem: 'python', detectedFrom: 'requirements.txt' });
        }
      }
    } catch { /* skip */ }
  }

  // Check pyproject.toml
  const pyprojectPath = join(repoPath, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf-8');
      if (content.includes('flask')) results.push({ name: 'flask', ecosystem: 'python', detectedFrom: 'pyproject.toml' });
      if (content.includes('fastapi')) results.push({ name: 'fastapi', ecosystem: 'python', detectedFrom: 'pyproject.toml' });
      if (content.includes('django')) results.push({ name: 'django', ecosystem: 'python', detectedFrom: 'pyproject.toml' });
    } catch { /* skip */ }
  }

  // Check if manage.py exists (Django)
  if (existsSync(join(repoPath, 'manage.py'))) {
    if (!results.some((r) => r.name === 'django')) results.push({ name: 'django', ecosystem: 'python', detectedFrom: 'manage.py' });
  }

  return results;
}

// ── Go detectors ───────────────────────────────────────────────────────────

function detectGoFrameworks(repoPath: string, _graph: KnowledgeGraph): FrameworkInfo[] {
  const results: FrameworkInfo[] = [];
  const modPath = join(repoPath, 'go.mod');
  if (!existsSync(modPath)) return results;

  try {
    const content = readFileSync(modPath, 'utf-8');
    const goFrameworks = [
      { name: 'gin', pattern: 'gin-gonic/gin' },
      { name: 'echo', pattern: 'labstack/echo' },
      { name: 'gorilla-mux', pattern: 'gorilla/mux' },
      { name: 'chi', pattern: 'go-chi/chi' },
      { name: 'fiber', pattern: 'gofiber/fiber' },
    ];
    for (const fw of goFrameworks) {
      if (content.includes(fw.pattern)) results.push({ name: fw.name, ecosystem: 'go', detectedFrom: 'go.mod' });
    }
  } catch { /* skip */ }
  return results;
}

// ── Rust detectors ─────────────────────────────────────────────────────────

function detectRustFrameworks(repoPath: string, _graph: KnowledgeGraph): FrameworkInfo[] {
  const results: FrameworkInfo[] = [];
  const cargoPath = join(repoPath, 'Cargo.toml');
  if (!existsSync(cargoPath)) return results;

  try {
    const content = readFileSync(cargoPath, 'utf-8');
    const rustFrameworks = ['actix-web', 'rocket', 'axum', 'warp', 'tide', 'tokio'];
    for (const fw of rustFrameworks) {
      if (content.includes(fw)) results.push({ name: fw, ecosystem: 'rust', detectedFrom: 'Cargo.toml' });
    }
  } catch { /* skip */ }
  return results;
}

// ── Main detector ──────────────────────────────────────────────────────────

const ALL_DETECTORS: FrameworkDetector[] = [
  detectJsFrameworks,
  detectPythonFrameworks,
  detectGoFrameworks,
  detectRustFrameworks,
];

export function detectFrameworks(repoPath: string, graph: KnowledgeGraph): FrameworkInfo[] {
  // Remove stale Framework nodes
  const staleFrameworks: string[] = [];
  for (const node of graph.iterNodes()) {
    if (node.label === 'Framework') staleFrameworks.push(node.id);
  }
  for (const id of staleFrameworks) graph.removeNode(id);

  const allFrameworks: FrameworkInfo[] = [];
  for (const detector of ALL_DETECTORS) {
    allFrameworks.push(...detector(repoPath, graph));
  }

  // Deduplicate by name
  const seen = new Set<string>();
  const unique = allFrameworks.filter((f) => {
    const key = f.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Create Framework nodes
  for (const fw of unique) {
    const fwId = `framework:${fw.ecosystem}:${fw.name}`;
    graph.addNode({
      id: fwId,
      label: 'Framework',
      properties: { name: fw.name, ecosystem: fw.ecosystem, version: fw.version, detectedFrom: fw.detectedFrom },
    });
  }

  return unique;
}
