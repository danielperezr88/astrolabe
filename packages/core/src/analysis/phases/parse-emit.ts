/**
 * Pipeline Phase: Parse-Emit
 *
 * Takes the scan output (FileEntry[]) and the graph context, parses each file
 * using the multi-language parser, then emits:
 *
 * - Symbol nodes (Function, Class, Method, Interface, Enum, TypeAlias, etc.)
 * - DEFINES edges (File → symbol)
 * - Import nodes and IMPORTS edges
 *
 * Supports chunked execution for large repos (> 1000 files).
 */

import { relative } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import { getPhaseOutput } from '../../core/pipeline.js';
import type { ScanOutput, FileEntry } from '../phases/scan.js';
import type { ParsedSymbol, ParsedImport, ParsedRelationship } from '../language-definition.js';
import { parseFile, defaultWasmDir } from '../parser.js';
import type { GraphNode, GraphRelationship } from '../../core/types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ParseEmitOutput {
  /** Number of symbol nodes created. */
  symbolCount: number;
  /** Number of import relationships created. */
  importCount: number;
  /** Number of files processed. */
  fileCount: number;
  /** Number of files that produced errors. */
  errorCount: number;
  /** Per-language symbol counts. */
  symbolCounts: Record<string, number>;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Files per chunk — process in batches to avoid memory pressure. */
const CHUNK_SIZE = 500;

/** File extensions that we can parse (derived from language registry to avoid desync) (#166). */
import { getAllExtensions } from '../parser.js';

function getParsableExtensions(): Set<string> {
  const exts = new Set<string>();
  for (const ext of getAllExtensions()) exts.add(ext);
  return exts;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Determine if a file entry should be parsed. */
function isParsable(entry: FileEntry): boolean {
  return getParsableExtensions().has(entry.extension.toLowerCase());
}

// ── Phase definition ────────────────────────────────────────────────────────

export const parseEmitPhase: PhaseDefinition<ParseEmitOutput> = {
  name: 'parse-emit',
  dependencies: ['scan', 'structure'],

  async execute(context: PhaseContext): Promise<ParseEmitOutput> {
    const scanOutput = getPhaseOutput<ScanOutput>(context, 'scan');
    const { graph, repoPath } = context;
    const wasmDir = defaultWasmDir();

    let symbolCount = 0;
    let importCount = 0;
    let fileCount = 0;
    let errorCount = 0;
    const symbolCounts: Record<string, number> = {};

    const parsable = scanOutput.files.filter(isParsable);

    // Process in chunks to keep memory under control
    for (let i = 0; i < parsable.length; i += CHUNK_SIZE) {
      const chunk = parsable.slice(i, i + CHUNK_SIZE);

      for (const entry of chunk) {
        fileCount++;
        const result = await parseFile(entry.absolutePath, wasmDir);

        if (result.error) {
          errorCount++;
          continue;
        }

        // ── Emit symbol nodes (normalize paths to repo-relative) ─────
        const relPath = relative(repoPath, entry.absolutePath).replace(/\\/g, '/');
        for (const sym of result.symbols) {
          emitSymbol(graph, sym, relPath);
          symbolCount++;
          symbolCounts[sym.label] = (symbolCounts[sym.label] ?? 0) + 1;
        }

        // ── Emit import relationships ────────────────────────────────────
        for (const imp of result.imports) {
          const edgeCount = emitImport(graph, imp, relPath);
          importCount += edgeCount;
        }

        // ── Emit tree-sitter relationships (EXTENDS, IMPLEMENTS) (#170) ──
        for (const rel of result.relationships) {
          emitRelationship(graph, rel, relPath);
        }

        // ── Infer parentClass for Methods/Constructors (#155) ─────────────
        // Language providers don't always set parentClass. Walk the file's
        // symbols to assign each Method/Constructor to its nearest Class.
        inferParentClasses(graph, relPath);
      }

      // Yield event-loop for very large repos
      await new Promise((r) => setImmediate(r));
    }

    return { symbolCount, importCount, fileCount, errorCount, symbolCounts };
  },
};

// ── Node / edge emitters ────────────────────────────────────────────────────

/**
 * Create a graph node from a parsed symbol.
 * Also creates a DEFINES edge: File → Symbol.
 * Uses addNode which is idempotent — duplicate symbols are safe.
 */
function emitSymbol(
  graph: PhaseContext['graph'],
  sym: ParsedSymbol,
  relPath: string,
): void {
  // Extract the :L<line> suffix from the parser's ID for uniqueness
  const lineSuffix = sym.id.includes(':L') ? sym.id.substring(sym.id.lastIndexOf(':L')) : '';

  const nodeId = `${sym.label}:${relPath}:${sym.name}${lineSuffix}`;
  const node: GraphNode = {
    id: nodeId,
    label: sym.label,
    properties: {
      name: sym.name,
      filePath: relPath,
      startLine: sym.startLine,
      endLine: sym.endLine,
      isExported: sym.isExported,
    },
  };
  graph.addNode(node);

  // DEFINES edge: File → Symbol
  graph.addRelationship({
    id: `defines:${relPath}:${nodeId}`,
    sourceId: `file:${relPath}`,
    targetId: nodeId,
    type: 'DEFINES',
    confidence: 1,
    reason: 'declared-in-file',
  });
}

/**
 * Create Import nodes and IMPORTS edges from a parsed import statement.
 *
 * Each import statement produces:
 * - An Import node (for the source module)
 * - An IMPORTS edge: File → Import node
 * - One IMPORTS edge per imported name: Import → target symbol
 *
 * For side-effect imports (no names), only the Import node is created.
 *
 * Returns the number of edges created.
 */
function emitImport(
  graph: PhaseContext['graph'],
  imp: ParsedImport,
  relPath: string,
): number {
  // Create Import node for the source module
  const importNode: GraphNode = {
    id: imp.id,
    label: 'Import',
    properties: {
      name: imp.source,
      filePath: relPath,
      startLine: imp.startLine,
      importedNames: imp.names.map((n) => n.name),
    },
  };
  graph.addNode(importNode);

  // IMPORTS: File → Import node (uses repo-relative path)
  const fileToImport: GraphRelationship = {
    id: `imports:${relPath}:to:${imp.source}:L${imp.startLine}`,
    sourceId: `file:${relPath}`,
    targetId: imp.id,
    type: 'IMPORTS',
    confidence: 1,
    reason: `import '${imp.source}'`,
  };
  graph.addRelationship(fileToImport);

  // Per-name IMPORTS edges are resolved in the resolution phase.
  // Return the count of actually created edges.
  return 1;
}

/**
 * Create EXTENDS / IMPLEMENTS edge from a tree-sitter relationship capture.
 *
 * The ParsedRelationship has sourceName + sourceStartLine + targetName within
 * the same file. We look up the source and target symbol nodes in the graph
 * and create the edge with moderate confidence (names match within file, but
 * cross-file resolution hasn't happened yet).
 */
function emitRelationship(
  graph: PhaseContext['graph'],
  rel: ParsedRelationship,
  relPath: string,
): void {
  // Find source node: match by filePath + name + startLine
  let sourceId: string | undefined;
  let targetId: string | undefined;

  for (const node of graph.iterNodes()) {
    if (node.properties.filePath !== relPath) continue;
    if (node.properties.name === rel.sourceName && node.properties.startLine === rel.sourceStartLine) {
      sourceId = node.id;
      if (targetId) break;
    }
    if (node.properties.name === rel.targetName && !node.properties.startLine) {
      // Target might be defined with a startLine too; try with and without
      targetId = node.id;
    }
  }

  // Fallback: try target by name only (no startLine match on purpose — target
  // may be defined elsewhere in file)
  if (!targetId) {
    for (const node of graph.iterNodes()) {
      if (node.properties.filePath !== relPath) continue;
      if (node.properties.name === rel.targetName) {
        targetId = node.id;
        break;
      }
    }
  }

  if (!sourceId || !targetId) return;

  const edgeId = `rel:${sourceId}:${rel.type.toLowerCase()}:${targetId}`;
  if (graph.getRelationship(edgeId)) return;

  graph.addRelationship({
    id: edgeId,
    sourceId,
    targetId,
    type: rel.type as GraphRelationship['type'],
    confidence: 0.7,
    reason: `tree-sitter ${rel.type.toLowerCase()} capture`,
  });
}

/**
 * Infer parentClass for Method and Constructor nodes from Class nodes
 * in the same file. For each Method/Constructor, finds the nearest Class
 * node that starts before it (#155).
 *
 * This is a universal fallback for all language providers that don't
 * explicitly set parentClass via tree-sitter captures.
 */
function inferParentClasses(
  graph: PhaseContext['graph'],
  filePath: string,
): void {
  // Collect Class nodes in this file with their line ranges
  const classes: Array<{ id: string; name: string; startLine: number; endLine: number }> = [];
  const methods: Array<{ id: string; startLine: number }> = [];

  for (const node of graph.iterNodes()) {
    if (node.properties.filePath !== filePath) continue;
    if (node.label === 'Class' || node.label === 'Interface' || node.label === 'Struct' || node.label === 'Trait') {
      classes.push({
        id: node.id,
        name: node.properties.name as string,
        startLine: (node.properties.startLine as number) ?? 0,
        endLine: (node.properties.endLine as number) ?? Infinity,
      });
    } else if (node.label === 'Method' || node.label === 'Constructor') {
      // Only set if not already explicitly set
      if (!node.properties.parentClass) {
        methods.push({ id: node.id, startLine: (node.properties.startLine as number) ?? 0 });
      }
    }
  }

  if (classes.length === 0 || methods.length === 0) return;

  // Sort classes by startLine for efficient lookup
  classes.sort((a, b) => a.startLine - b.startLine);

  for (const method of methods) {
    // Find the nearest class that starts before this method
    let best: typeof classes[0] | null = null;
    for (const cls of classes) {
      if (cls.startLine <= method.startLine && method.startLine <= cls.endLine) {
        best = cls;
      }
    }
    if (best) {
      const node = graph.getNode(method.id);
      if (node) {
        node.properties.parentClass = best.name;
      }
    }
  }
}
