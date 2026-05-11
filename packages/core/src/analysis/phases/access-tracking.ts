/**
 * Pipeline Phase: Access Tracking (#750)
 *
 * Detects field/property read and write access patterns within
 * Method/Function/Constructor bodies. Creates ACCESSES edges from
 * the function/method to the accessed Property node with a
 * read/write reason.
 *
 * Uses a simple regex-based approach for member expression detection.
 * Writes are detected by assignment operators on property expressions.
 * Only runs for TypeScript/JavaScript files (extensible).
 *
 * Runs after core symbol emission so Property/Class nodes exist.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

export interface AccessTrackingOutput {
  accessCount: number;
  readCount: number;
  writeCount: number;
}

/**
 * Match member expressions: obj.field, this.field, self.field
 * Group 1: object name, Group 2: property name
 */
const MEMBER_EXPRESSION_RE = /([a-zA-Z_$][\w$]*)\.([a-zA-Z_$][\w$]*)/g;

/**
 * Match assignment to property: obj.field = ..., obj.field += ..., etc.
 * Group 1: object name, Group 2: property name
 */
const ASSIGN_TO_PROPERTY_RE = /\b([a-zA-Z_$][\w$]*)\.([a-zA-Z_$][\w$]*)\s*(?:\+|-|\*|\/|%|\*\*|<<|>>|>>>|&&|\|\||\?\?)?=/g;

export const accessTrackingPhase: PhaseDefinition<AccessTrackingOutput> = {
  name: 'access-tracking',
  dependencies: ['parse-emit'],

  shouldSkip(context: PhaseContext): boolean {
    const inc = context.incremental;
    if (!inc?.isIncremental) return false;
    return inc.changedPaths.size + inc.addedPaths.size === 0;
  },

  execute(context: PhaseContext): AccessTrackingOutput {
    const { graph, repoPath, incremental } = context;
    const affectedFiles = incremental?.isIncremental
      ? new Set([...incremental.changedPaths, ...incremental.addedPaths])
      : null;

    let accessCount = 0;
    let readCount = 0;
    let writeCount = 0;

    // Collect all Property nodes indexed by (filePath, name)
    const propertyIndex = new Map<string, Map<string, string>>(); // key → nodeId
    for (const node of graph.iterNodes()) {
      if (node.label !== 'Property') continue;
      const fp = node.properties.filePath as string;
      const name = node.properties.name as string;
      if (!fp || !name) continue;
      let fm = propertyIndex.get(fp);
      if (!fm) { fm = new Map(); propertyIndex.set(fp, fm); }
      fm.set(name, node.id);
    }

    // Collect function-like nodes (Methods, Functions, Constructors) with their file paths
    interface FuncNode { id: string; fp: string; startLine: number; endLine: number; name: string; ownerClass?: string; }
    const funcNodes: FuncNode[] = [];
    for (const node of graph.iterNodes()) {
      if (node.label !== 'Method' && node.label !== 'Function' && node.label !== 'Constructor') continue;
      const fp = node.properties.filePath as string;
      if (!fp) continue;
      if (affectedFiles && !affectedFiles.has(fp)) continue;

      funcNodes.push({
        id: node.id,
        fp,
        name: node.properties.name as string,
        startLine: (node.properties.startLine as number) ?? 0,
        endLine: (node.properties.endLine as number) ?? Infinity,
        ownerClass: node.properties.parentClass as string | undefined,
      });
    }

    // Process each function body
    for (const fn of funcNodes) {
      const absPath = resolve(repoPath, fn.fp);
      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      if (fn.startLine < 1 || fn.endLine > lines.length) continue;

      // Extract the function body text (line range)
      const bodyLines = lines.slice(fn.startLine - 1, fn.endLine);
      const bodyText = bodyLines.join('\n');

      // Detect writes (assignment to property)
      const writes = new Map<string, number>(); // propertyName → count
      let matchW: RegExpExecArray | null;
      ASSIGN_TO_PROPERTY_RE.lastIndex = 0;
      while ((matchW = ASSIGN_TO_PROPERTY_RE.exec(bodyText)) !== null) {
        const objName = matchW[1];
        const propName = matchW[2];
        // Skip 'this.constructor' and 'super.*' (not field accesses)
        if (propName === 'constructor' || objName === 'super') continue;
        writes.set(propName, (writes.get(propName) ?? 0) + 1);
      }

      // Detect all member expressions (reads + writes)
      const allAccesses = new Map<string, number>();
      let matchA: RegExpExecArray | null;
      MEMBER_EXPRESSION_RE.lastIndex = 0;
      while ((matchA = MEMBER_EXPRESSION_RE.exec(bodyText)) !== null) {
        const objName = matchA[1];
        const propName = matchA[2];
        if (propName === 'constructor' || objName === 'super' || objName === 'prototype') continue;
        allAccesses.set(propName, (allAccesses.get(propName) ?? 0) + 1);
      }

      if (allAccesses.size === 0) continue;

      // Find the target file's property index
      const fileProps = propertyIndex.get(fn.fp);
      if (!fileProps && writes.size === 0 && allAccesses.size === 0) continue;

      // Create ACCESSES edges
      for (const [propName] of allAccesses) {
        const isWrite = writes.has(propName);
        const reason = isWrite ? 'write' : 'read';

        // Look up Property node in same file
        let targetId: string | undefined;
        if (fileProps) {
          targetId = fileProps.get(propName);
        }
        // Fallback: also search the owner class's file index
        if (!targetId && fn.ownerClass) {
          const ownerNode = graph.getNode(fn.ownerClass);
          const ownerFp = ownerNode?.properties.filePath as string | undefined;
          if (ownerFp) {
            const ownerProps = propertyIndex.get(ownerFp);
            if (ownerProps) {
              targetId = ownerProps.get(propName);
            }
          }
        }

        if (!targetId) continue;

        const edgeId = `access:${fn.id}:${reason}:${propName}:${targetId}`;
        if (graph.getRelationship(edgeId)) continue;

        graph.addRelationship({
          id: edgeId,
          sourceId: fn.id,
          targetId,
          type: 'ACCESSES',
          confidence: 0.7,
          reason,
        });

        accessCount++;
        if (isWrite) writeCount++; else readCount++;
      }
    }

    return { accessCount, readCount, writeCount };
  },
};
