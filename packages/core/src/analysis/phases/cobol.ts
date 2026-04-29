/**
 * Pipeline Phase: COBOL Detection (#271)
 *
 * Regex-based COBOL program detection without tree-sitter.
 * Detects PROGRAM-ID, CALL, COPY, PERFORM statements and creates
 * graph nodes/edges for legacy enterprise codebase analysis.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import { getPhaseOutput } from '../../core/pipeline.js';
import type { ScanOutput } from '../phases/scan.js';

export interface CobolOutput {
  programCount: number;
  callCount: number;
  copyCount: number;
}

// ── Regex patterns ─────────────────────────────────────────────────────────

const PROGRAM_ID_RE = /PROGRAM-ID\s*\.\s*(\w[\w-]*)/gi;
const CALL_RE = /CALL\s+(?:'|")([^'"]+)(?:'|")/gi;
const COPY_RE = /COPY\s+(?:'|")([^'"]+)(?:'|")/gi;

// ── Phase ──────────────────────────────────────────────────────────────────

export const cobolPhase: PhaseDefinition<CobolOutput> = {
  name: 'cobol',
  dependencies: ['scan', 'structure'],

  execute(context: PhaseContext): CobolOutput {
    const scanOutput = getPhaseOutput<ScanOutput>(context, 'scan');
    const { graph } = context;
    let programCount = 0;
    let callCount = 0;
    let copyCount = 0;

    const cobolFiles = scanOutput?.files?.filter(
      (f) => /\.(cbl|cob|cobol|cpy)$/i.test(f.path),
    ) ?? [];

    if (cobolFiles.length === 0) return { programCount: 0, callCount: 0, copyCount: 0 };

    for (const file of cobolFiles) {
      let source: string;
      try { source = readFileSync(file.path, 'utf-8'); } catch { continue; }

      // Detect PROGRAM-ID
      let programName = '';
      for (const m of source.matchAll(PROGRAM_ID_RE)) {
        programName = m[1];
        const id = `cobol:program:${file.path}:${programName}`;
        if (!graph.getNode(id)) {
          graph.addNode({
            id,
            label: 'CodeElement',
            properties: { name: programName, filePath: file.path, kind: 'COBOL Program' },
          });
          programCount++;
        }
      }

      // If no PROGRAM-ID found, use filename
      if (!programName) {
        programName = basename(file.path).replace(/\.(cbl|cob|cobol)$/i, '');
        const id = `cobol:program:${file.path}:${programName}`;
        if (!graph.getNode(id)) {
          graph.addNode({
            id,
            label: 'CodeElement',
            properties: { name: programName, filePath: file.path, kind: 'COBOL Program' },
          });
          programCount++;
        }
      }

      const sourceNodeId = `cobol:program:${file.path}:${programName}`;

      // Detect CALL statements
      for (const m of source.matchAll(CALL_RE)) {
        const calledProgram = m[1];
        const targetId = `cobol:program:${calledProgram}`;
        const edgeId = `calls:${sourceNodeId}:to:${targetId}`;
        if (!graph.getRelationship(edgeId)) {
          graph.addRelationship({
            id: edgeId,
            sourceId: sourceNodeId,
            targetId: targetId,
            type: 'CALLS',
            confidence: 0.7,
            reason: `CALL '${calledProgram}' in ${file.path}`,
          });
          callCount++;
        }
      }

      // Detect COPY statements
      for (const m of source.matchAll(COPY_RE)) {
        const copybook = m[1];
        const targetId = `cobol:copybook:${copybook}`;
        const edgeId = `copy:${sourceNodeId}:to:${targetId}`;
        if (!graph.getRelationship(edgeId)) {
          graph.addRelationship({
            id: edgeId,
            sourceId: sourceNodeId,
            targetId: targetId,
            type: 'IMPORTS',
            confidence: 0.6,
            reason: `COPY '${copybook}' in ${file.path}`,
          });
          copyCount++;
        }
      }
    }

    return { programCount, callCount, copyCount };
  },
};
