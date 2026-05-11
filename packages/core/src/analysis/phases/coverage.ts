/**
 * Pipeline Phase: Coverage Annotation (#463).
 *
 * Reads a coverage report (path supplied via context.state) and annotates
 * graph nodes with coverage metadata.  Function/Method nodes receive
 * per-function coverage; File nodes receive aggregate file coverage.
 *
 * Coverage data is stored on node.properties._coverage (underscore-prefix
 * convention for external metadata).
 *
 * Runs after parse-emit so Function/Method/File nodes already exist.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import {
  parseCoverageReport,
  detectFormat,
  coveragePathMatches,
  type CoverageReport,
} from '../coverage/parser.js';

// #463: Output type for the coverage phase

export interface CoverageScanOutput {
  filesProcessed: number;
  totalCoverage: number;
  uncoveredNodes: number;
}

// #463: Coverage annotation stored on node.properties._coverage
export interface CoverageAnnotation {
  lineCoverage: number;
  functionCoverage: number;
  uncoveredLines: number[];
}

/**
 * #463: Determine coverage status from function coverage percentage.
 * - 0% → 'uncovered'
 * - < 50% → 'partial'
 * - >= 80% → 'covered'
 * - otherwise → 'partial'
 */
function coverageStatus(fnCov: number): 'uncovered' | 'partial' | 'covered' {
  if (fnCov === 0) return 'uncovered';
  if (fnCov >= 80) return 'covered';
  if (fnCov < 50) return 'partial';
  return 'partial';
}

/**
 * #463: Annotate graph nodes with coverage data from a parsed report.
 * Shared logic used by both the pipeline phase and the CLI command.
 */
export function annotateGraphWithCoverage(
  graph: import('@astrolabe-dev/shared').KnowledgeGraph,
  report: CoverageReport,
): CoverageScanOutput {
  let filesProcessed = 0;
  let uncoveredNodes = 0;

  // Build a file-path index of graph nodes
  const nodesByFile = new Map<string, Array<{ id: string; label: string; name: string; startLine?: number }>>();
  for (const node of graph.iterNodes()) {
    const fp = node.properties.filePath as string;
    if (!fp) continue;
    let bucket = nodesByFile.get(fp);
    if (!bucket) { bucket = []; nodesByFile.set(fp, bucket); }
    bucket.push({
      id: node.id,
      label: node.label,
      name: (node.properties.name as string) ?? '',
      startLine: node.properties.startLine as number | undefined,
    });
  }

  for (const fileCov of report.files) {
    // Find matching graph nodes for this file
    let matchedNodes: Array<{ id: string; label: string; name: string; startLine?: number }> | undefined;
    for (const [graphPath, nodes] of nodesByFile.entries()) {
      if (coveragePathMatches(fileCov.filePath, graphPath)) {
        matchedNodes = nodes;
        break;
      }
    }

    if (!matchedNodes) continue;
    filesProcessed++;

    const uncoveredLines = fileCov.lines
      .filter((l) => l.hitCount === 0)
      .map((l) => l.line);

    const annotation: CoverageAnnotation = {
      lineCoverage: fileCov.lineCoverage,
      functionCoverage: fileCov.functionCoverage,
      uncoveredLines,
    };

    const status = coverageStatus(fileCov.functionCoverage);

    // Annotate File nodes with aggregate coverage
    for (const n of matchedNodes) {
      if (n.label === 'File' || n.label === 'Folder') {
        const node = graph.getNode(n.id);
        if (node) {
          node.properties._coverage = annotation;
          node.properties._coverageStatus = status;
        }
      }
    }

    // Annotate Function/Method/Constructor nodes with per-function coverage
    for (const fnCov of fileCov.functions) {
      // Find the best matching function node by name and line proximity
      let bestMatch: { id: string; label: string; name: string; startLine?: number } | undefined;
      let bestDist = Infinity;

      for (const n of matchedNodes) {
        if (n.label !== 'Function' && n.label !== 'Method' && n.label !== 'Constructor') continue;
        if (n.name !== fnCov.name) continue;
        if (n.startLine !== undefined && fnCov.line > 0) {
          const dist = Math.abs(n.startLine - fnCov.line);
          if (dist < bestDist) {
            bestDist = dist;
            bestMatch = n;
          }
        } else {
          // Name matches but no line info — use if no better match
          if (!bestMatch) bestMatch = n;
        }
      }

      if (bestMatch) {
        const node = graph.getNode(bestMatch.id);
        if (node) {
          const fnStatus = fnCov.hitCount > 0
            ? 'covered'
            : 'uncovered';
          node.properties._coverage = {
            lineCoverage: fnCov.hitCount > 0 ? 100 : 0,
            functionCoverage: fnCov.hitCount > 0 ? 100 : 0,
            uncoveredLines: fnCov.hitCount > 0 ? [] : (fnCov.line > 0 ? [fnCov.line] : []),
          };
          node.properties._coverageStatus = fnStatus;
          if (fnStatus === 'uncovered') uncoveredNodes++;
        }
      }
    }

    // Count uncovered file-level nodes
    if (status === 'uncovered') {
      for (const n of matchedNodes) {
        if (n.label === 'File') uncoveredNodes++;
      }
    }
  }

  return {
    filesProcessed,
    totalCoverage: report.lineCoveragePercent,
    uncoveredNodes,
  };
}

export const coveragePhase: PhaseDefinition<CoverageScanOutput> = {
  name: 'coverage',
  dependencies: ['parse-emit'],

  execute(context: PhaseContext): CoverageScanOutput {
    // #463: Check if coverage report path is provided via context.state
    const reportPath = context.state.get('coverage:reportPath') as string | undefined;
    if (!reportPath) return { filesProcessed: 0, totalCoverage: 0, uncoveredNodes: 0 };

    // Read the coverage report file
    let content: string;
    try {
      content = readFileSync(resolve(reportPath), 'utf-8');
    } catch {
      return { filesProcessed: 0, totalCoverage: 0, uncoveredNodes: 0 };
    }

    // Detect format or use specified format
    const format = (context.state.get('coverage:format') as 'lcov' | 'istanbul' | 'cobertura' | undefined)
      ?? detectFormat(content);
    if (!format) return { filesProcessed: 0, totalCoverage: 0, uncoveredNodes: 0 };

    // Parse the report
    const report = parseCoverageReport(content, format);

    // Annotate graph nodes
    return annotateGraphWithCoverage(context.graph, report);
  },
};
