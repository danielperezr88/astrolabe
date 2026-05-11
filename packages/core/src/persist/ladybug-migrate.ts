/**
 * LadybugDB (GitNexus) → Astrolabe SQLite Migration Bridge (#771)
 *
 * Reads GitNexus .gitnexus/ CSV exports and imports them into our SQLite
 * knowledge graph format.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { GraphNode, GraphRelationship, NodeLabel, RelationshipType } from '../core/types.js';
import { createSqliteStore } from './sqlite.js';

// #771: Migration result returned to callers
export interface MigrationResult {
  nodeCount: number;
  edgeCount: number;
  skippedTypes: string[];
  warnings: string[];
}

// #771: GitNexus node CSV file → Astrolabe NodeLabel mapping
const NODE_TYPE_MAP: Record<string, NodeLabel | null> = {
  'function.csv': 'Function',
  'class.csv': 'Class',
  'interface.csv': 'Interface',
  'method.csv': 'Function',
  'codeelement.csv': 'Function',
  'file.csv': 'File',
  'folder.csv': 'File',
  'community.csv': 'Community',
  'process.csv': 'Process',
  'route.csv': 'Route',
  'tool.csv': 'Tool',
  'variable.csv': 'Variable',
  'property.csv': 'Property',
  'struct.csv': 'Class',
  'enum.csv': 'Enum',
  'const.csv': 'Variable',
  'section.csv': 'File',
  // Skip embedding.csv and other non-matching types
  'embedding.csv': null,
};

// #771: GitNexus relationship type → Astrolabe RelationshipType mapping
const REL_TYPE_MAP: Record<string, RelationshipType | 'SKIP'> = {
  CONTAINS: 'CONTAINS',
  CALLS: 'CALLS',
  IMPORTS: 'IMPORTS',
  EXTENDS: 'EXTENDS',
  IMPLEMENTS: 'IMPLEMENTS',
  HAS_METHOD: 'HAS_METHOD',
  HAS_PROPERTY: 'HAS_PROPERTY',
  ACCESSES: 'ACCESSES',
  QUERIES: 'QUERIES',
  STEP_IN_PROCESS: 'STEP_IN_PROCESS',
  HANDLES_ROUTE: 'HANDLES_ROUTE',
  HANDLES_TOOL: 'HANDLES_TOOL',
  ENTRY_POINT_OF: 'ENTRY_POINT_OF',
  MEMBER_OF: 'MEMBER_OF',
  USES: 'USES',
  USES_FRAMEWORK: 'USES_FRAMEWORK',
  DECORATES: 'DECORATES',
  // Mapped types
  DEFINES: 'CONTAINS',
  OVERRIDES: 'METHOD_OVERRIDES',
  // Skipped types — no Astrolabe equivalent
  FETCHES: 'SKIP',
  WRAPS: 'SKIP',
};

// #771: Parse LadybugDB array format: ['val1','val2'] → ['val1', 'val2']
export function parseLadybugArray(str: string): string[] {
  if (!str || str === '[]') return [];
  // Strip outer brackets and quotes: ['val1','val2'] or ["val1","val2"]
  const inner = str.replace(/^\[\s*['"]|['"]\s*\]$/g, '');
  if (!inner) return [];
  return inner.split(/['"]\s*,\s*['"]/).map((s) => s.trim());
}

// #771: RFC 4180 CSV parser — handles quoted fields with embedded commas and double-quotes
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  const len = line.length;

  while (i <= len) {
    if (i === len) {
      // Trailing empty field after comma
      if (fields.length > 0 && line[len - 1] === ',') {
        fields.push('');
      }
      break;
    }

    if (line[i] === '"') {
      // Quoted field — consume until closing double-quote
      i++; // skip opening quote
      let field = '';
      while (i < len) {
        if (line[i] === '"') {
          if (i + 1 < len && line[i + 1] === '"') {
            // Escaped double-quote
            field += '"';
            i += 2;
          } else {
            // End of quoted field
            i++; // skip closing quote
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      fields.push(field);
      // Skip comma separator
      if (i < len && line[i] === ',') i++;
    } else {
      // Unquoted field — read until comma or end
      let field = '';
      while (i < len && line[i] !== ',') {
        field += line[i];
        i++;
      }
      fields.push(field);
      // Skip comma separator
      if (i < len && line[i] === ',') i++;
    }
  }

  return fields;
}

// #771: Read and parse an entire CSV file into rows
export function parseCsvFile(filePath: string): Record<string, string>[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return []; // Need at least header + one row

  const header = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.length === 0) continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = j < values.length ? values[j] : '';
    }
    rows.push(row);
  }

  return rows;
}

// #771: Build a GraphNode from a CSV row
function buildNode(row: Record<string, string>, label: NodeLabel): GraphNode {
  const props: Record<string, unknown> = {
    name: row.name ?? '',
    ...(row.filePath ? { filePath: row.filePath } : {}),
    ...(row.startLine && row.startLine !== '-1' ? { startLine: Number(row.startLine) } : {}),
    ...(row.endLine && row.endLine !== '-1' ? { endLine: Number(row.endLine) } : {}),
    ...(row.isExported ? { isExported: row.isExported === 'true' } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.returnType ? { returnType: row.returnType } : {}),
    ...(row.parameterCount ? { parameterCount: Number(row.parameterCount) } : {}),
    ...(row.declaredType ? { declaredType: row.declaredType } : {}),
    // Community-specific
    ...(row.heuristicLabel ? { heuristicLabel: row.heuristicLabel } : {}),
    ...(row.cohesion ? { cohesion: Number(row.cohesion) } : {}),
    ...(row.symbolCount ? { symbolCount: Number(row.symbolCount) } : {}),
    ...(row.keywords ? { keywords: parseLadybugArray(row.keywords) } : {}),
    // Process-specific
    ...(row.processType ? { processType: row.processType } : {}),
    ...(row.stepCount ? { stepCount: Number(row.stepCount) } : {}),
    ...(row.entryPointId ? { entryPointId: row.entryPointId } : {}),
    // Route-specific
    ...(row.responseKeys ? { responseKeys: parseLadybugArray(row.responseKeys) } : {}),
    ...(row.middleware ? { middleware: parseLadybugArray(row.middleware) } : {}),
    // Visibility / modifiers
    ...(row.visibility ? { visibility: row.visibility } : {}),
    ...(row.isStatic ? { isStatic: row.isStatic === 'true' } : {}),
    ...(row.isAsync ? { isAsync: row.isAsync === 'true' } : {}),
    ...(row.language ? { language: row.language } : {}),
  };

  return {
    id: row.id,
    label,
    properties: props,
  };
}

// #771: Build a GraphRelationship from a relations.csv row
function buildRelationship(
  row: Record<string, string>,
  type: RelationshipType,
): GraphRelationship {
  return {
    id: `${row.from}-${row.type}-${row.to}`,
    sourceId: row.from,
    targetId: row.to,
    type,
    confidence: row.confidence ? Number(row.confidence) : 1.0,
    reason: row.reason || '',
    ...(row.step && row.step !== '-1' ? { step: Number(row.step) } : {}),
  };
}

/**
 * #771: Migrate GitNexus LadybugDB CSV files into Astrolabe's SQLite format.
 *
 * @param gitnexusPath - Path to repo root (looks for `.gitnexus/` directory)
 * @param targetDbPath - Path to output SQLite database file
 * @returns Migration result with counts and any warnings
 */
export function migrateFromGitNexus(
  gitnexusPath: string,
  targetDbPath: string,
): MigrationResult {
  const warnings: string[] = [];
  const skippedTypes = new Set<string>();
  let nodeCount = 0;
  let edgeCount = 0;

  const nexusDir = join(gitnexusPath, '.gitnexus');
  if (!existsSync(nexusDir)) {
    throw new Error(`No .gitnexus directory found at ${gitnexusPath}`);
  }

  // Ensure output directory exists
  const outDir = dirname(targetDbPath);
  if (outDir !== '.' && !existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // Create or load existing SQLite store
  const store = createSqliteStore(targetDbPath);
  try {
    const graph = store.loadGraph();

    // ── Migrate nodes from CSV files ──────────────────────────────────────
    const files = readdirSync(nexusDir).filter((f) => f.endsWith('.csv'));

    for (const file of files) {
      const label = NODE_TYPE_MAP[file];

      // Skip files with no mapping (embedding.csv, unknown types)
      if (label === null || label === undefined) {
        if (label === null) {
          // Explicitly skipped (e.g. embedding.csv)
        } else {
          skippedTypes.add(file.replace('.csv', ''));
          warnings.push(`Skipping unknown node type file: ${file}`);
        }
        continue;
      }

      const rows = parseCsvFile(join(nexusDir, file));
      for (const row of rows) {
        if (!row.id) {
          warnings.push(`Skipping row without id in ${file}`);
          continue;
        }
        try {
          graph.addNode(buildNode(row, label));
          nodeCount++;
        } catch (err: any) {
          warnings.push(`Failed to add node ${row.id} from ${file}: ${err.message}`);
        }
      }
    }

    // ── Migrate relationships ─────────────────────────────────────────────
    const relFiles = ['relations.csv', 'relationships.csv'];
    for (const relFile of relFiles) {
      const relPath = join(nexusDir, relFile);
      if (!existsSync(relPath)) continue;

      const rows = parseCsvFile(relPath);
      for (const row of rows) {
        if (!row.from || !row.to || !row.type) {
          warnings.push(`Skipping malformed relationship row in ${relFile}`);
          continue;
        }

        const mappedType = REL_TYPE_MAP[row.type];
        if (mappedType === 'SKIP') {
          skippedTypes.add(row.type);
          continue;
        }
        if (mappedType === undefined) {
          skippedTypes.add(row.type);
          warnings.push(`Skipping unknown relationship type: ${row.type}`);
          continue;
        }

        try {
          graph.addRelationship(buildRelationship(row, mappedType));
          edgeCount++;
        } catch (err: any) {
          warnings.push(`Failed to add relationship ${row.from}→${row.to}: ${err.message}`);
        }
      }
      break; // Only process the first found rel file
    }

    // Persist the merged graph
    store.saveGraph(graph);
  } finally {
    store.close();
  }

  return {
    nodeCount,
    edgeCount,
    skippedTypes: Array.from(skippedTypes),
    warnings,
  };
}
