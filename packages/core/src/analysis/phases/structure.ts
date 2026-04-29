/**
 * Pipeline Phase: Structure
 *
 * Takes the scan output (FileEntry[]) and builds Folder / File graph nodes
 * with CONTAINS relationships. Also detects package boundaries by looking
 * for well-known package manifest files.
 */

import { dirname } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import { getPhaseOutput } from '../../core/pipeline.js';
import type { ScanOutput } from './scan.js';
import type { GraphNode, GraphRelationship } from '../../core/types.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** Output produced by the structure phase. */
export interface StructureOutput {
  fileCount: number;
  folderCount: number;
  maxDepth: number;
  packageCount: number;
}

// ── Package manifest files ──────────────────────────────────────────────────

const PACKAGE_MANIFESTS = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'build.gradle',
  'build.gradle.kts',
  'pom.xml',
  'CMakeLists.txt',
  'Makefile',
  'Gemfile',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a file-backed NodeProperties bag. */
function fileProps(filePath: string, name: string, language: string | null): Record<string, unknown> {
  return {
    name,
    filePath,
    ...(language ? { language } : {}),
  };
}

/** Build a folder/package-backed NodeProperties bag. */
function folderProps(dirPath: string, name: string): Record<string, unknown> {
  return {
    name,
    filePath: dirPath,
  };
}

/** Compute folder depth (number of path segments from root). */
function depthOf(relPath: string): number {
  if (relPath === '.' || relPath === '') return 0;
  return relPath.split('/').length;
}

// ── Phase definition ────────────────────────────────────────────────────────

export const structurePhase: PhaseDefinition<StructureOutput> = {
  name: 'structure',
  dependencies: ['scan'],

  execute(context: PhaseContext): StructureOutput {
    const scanOutput = getPhaseOutput<ScanOutput>(context, 'scan');
    const { graph } = context;

    if (!scanOutput?.files?.length) {
      return { fileCount: 0, folderCount: 0, maxDepth: 0, packageCount: 0 };
    }

    // #280: Support incremental indexing — only process changed/added files
    const changedPaths = context.state.get('incremental:changedPaths') as Set<string> | undefined;

    // Track which folders we've seen (to avoid duplicate nodes)
    const folderIds = new Set<string>();
    let fileCount = 0;
    let maxDepth = 0;

    // ── Create File nodes ─────────────────────────────────────────────────
    for (const entry of scanOutput.files) {
      if (changedPaths && !changedPaths.has(entry.path)) continue;
      const id = `file:${entry.path}`;
      const fileName = entry.path.split('/').pop() || entry.path;
      const node: GraphNode = {
        id,
        label: 'File',
        properties: fileProps(entry.path, fileName, entry.language),
      };
      graph.addNode(node);
      fileCount++;

      const d = depthOf(dirname(entry.path).replace(/\\/g, '/'));
      if (d > maxDepth) maxDepth = d;

      // Ensure all ancestor folders exist
      const dir = dirname(entry.path).replace(/\\/g, '/');
      if (dir === '.') continue;
      ensureFolderPath(graph, dir, folderIds);
    }

    // ── Create CONTAINS edges ──────────────────────────────────────────────
    // Build file-by-folder index for O(Files) instead of O(Folders × Files) (#172)
    const filesByDir = new Map<string, typeof scanOutput.files>();
    for (const entry of scanOutput.files) {
      const dir = dirname(entry.path).replace(/\\/g, '/');
      let arr = filesByDir.get(dir);
      if (!arr) { arr = []; filesByDir.set(dir, arr); }
      arr.push(entry);
    }

    const allFolders = Array.from(folderIds);

    for (const folderPath of allFolders) {
      const folderId = `folder:${folderPath}`;
      const parentDir = dirname(folderPath).replace(/\\/g, '/');

      // CONTAINS for files directly in this folder
      const entries = filesByDir.get(folderPath);
      if (entries) {
        for (const entry of entries) {
          const edge: GraphRelationship = {
            id: `contains:${folderPath}:file:${entry.path}`,
            sourceId: folderId,
            targetId: `file:${entry.path}`,
            type: 'CONTAINS',
            confidence: 1,
            reason: 'folder-structure',
          };
          graph.addRelationship(edge);
        }
      }

      // CONTAINS for child folders
      if (parentDir !== '.') {
        const parentId = `folder:${parentDir}`;
        if (folderIds.has(parentDir)) {
          const edge: GraphRelationship = {
            id: `contains:${parentDir}:folder:${folderPath}`,
            sourceId: parentId,
            targetId: folderId,
            type: 'CONTAINS',
            confidence: 1,
            reason: 'folder-structure',
          };
          graph.addRelationship(edge);
        }
      }
    }

    // ── Detect package boundaries ──────────────────────────────────────────
    let packageCount = 0;

    for (const entry of scanOutput.files) {
      if (changedPaths && !changedPaths.has(entry.path)) continue;
      const fileName = entry.path.split('/').pop() || '';
      if (!PACKAGE_MANIFESTS.includes(fileName)) continue;

      const pkgDir = dirname(entry.path).replace(/\\/g, '/');

      const pkgId = `pkg:${pkgDir}:${fileName}`;
      const existing = graph.getNode(pkgId);
      if (existing) {
        // Already captured this manifest — skip
        continue;
      }

      const pkgType = fileName === 'package.json' ? 'npm'
        : fileName === 'Cargo.toml' ? 'cargo'
        : fileName === 'go.mod' ? 'gomod'
        : (fileName === 'pyproject.toml' || fileName === 'setup.py') ? 'python'
        : 'unknown';

      const pkgNode: GraphNode = {
        id: pkgId,
        label: 'Package',
        properties: {
          name: pkgDir.split('/').pop() || 'root',
          filePath: pkgDir,
          packageType: pkgType,
        },
      };
      graph.addNode(pkgNode);
      packageCount++;

      // CONTAINS edge from package to its root folder
      if (folderIds.has(pkgDir)) {
        const pkgEdge: GraphRelationship = {
          id: `contains:${pkgId}:folder:${pkgDir}`,
          sourceId: pkgId,
          targetId: `folder:${pkgDir}`,
          type: 'CONTAINS',
          confidence: 1,
          reason: 'package-boundary',
        };
        graph.addRelationship(pkgEdge);
      }
    }

    return {
      fileCount,
      folderCount: folderIds.size,
      maxDepth,
      packageCount,
    };
  },
};

// ── Folder tree builder ─────────────────────────────────────────────────────

/**
 * Ensure that a folder node and all its ancestors exist in the graph.
 * Called for every file to lazily build the folder hierarchy.
 */
function ensureFolderPath(
  graph: PhaseContext['graph'],
  folderPath: string,
  folderIds: Set<string>,
): void {
  const parts = folderPath.split('/');
  let accumulated = '';

  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    const id = `folder:${accumulated}`;

    if (!folderIds.has(accumulated)) {
      folderIds.add(accumulated);
      graph.addNode({
        id,
        label: 'Folder',
        properties: folderProps(accumulated, part),
      });
    }
  }
}
