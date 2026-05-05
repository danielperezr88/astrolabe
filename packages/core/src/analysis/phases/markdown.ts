/**
 * Pipeline Phase: Markdown Document Parsing
 *
 * Parses .md and .mdx files to extract headings, cross-links,
 * and code references. Creates Section nodes and cross-reference edges.
 *
 * Dependencies: structure (needs file list)
 * Output: Section nodes + CROSS_REFERENCES edges
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { toPosix } from '@astrolabe/shared';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

export interface MarkdownOutput {
  sectionCount: number;
  crossRefCount: number;
  fileCount: number;
}

export const markdownPhase: PhaseDefinition<MarkdownOutput> = {
  name: 'markdown',
  dependencies: ['structure'],

  async execute(context: PhaseContext): Promise<MarkdownOutput> {
    const { graph } = context;
    let sectionCount = 0;
    let crossRefCount = 0;
    let fileCount = 0;

    // #280: Support incremental indexing — only process changed/added files
    const changedPaths = context.state.get('incremental:changedPaths') as Set<string> | undefined;

    // Collect markdown files with their heading data
    const mdFiles: Array<{
      id: string; filePath: string;
      headings: Array<{ level: number; text: string; line: number; slug: string }>;
      links: Array<{ text: string; target: string; line: number }>;
    }> = [];

    for (const node of graph.iterNodes()) {
      if (node.label !== 'File') continue;
      const fp = node.properties.filePath as string | undefined;
      if (!fp || !/\.(md|mdx)$/i.test(fp)) continue;
      if (changedPaths && !changedPaths.has(fp)) continue;

      try {
        const content = await readFile(join(context.repoPath, fp), 'utf-8');
        const headings: Array<{ level: number; text: string; line: number; slug: string }> = [];
        const links: Array<{ text: string; target: string; line: number }> = [];

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hMatch = line.match(/^(#{1,6})\s+(.+)/);
          if (hMatch) {
            const level = hMatch[1].length;
            const text = hMatch[2].trim().replace(/[#*`\[\]]/g, '');
            const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            headings.push({ level, text, line: i + 1, slug });
          }
          const lRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
          let lMatch;
          while ((lMatch = lRegex.exec(line)) !== null) {
            links.push({ text: lMatch[1], target: lMatch[2], line: i + 1 });
          }
        }

        if (headings.length > 0 || links.length > 0) {
          mdFiles.push({ id: node.id, filePath: fp, headings, links });
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Pass 1: Create Section nodes and build global heading index (#194)
    const globalSections = new Map<string, string>(); // fileRelPath|slug → sectionId
    // #202: Secondary index by file path for O(1) cross-file lookup
    const fileSectionIndex = new Map<string, Array<{ slug: string; sectionId: string }>>();

    for (const file of mdFiles) {
      if (file.headings.length === 0) continue;
      fileCount++;

      const sections: Array<{ slug: string; sectionId: string }> = [];
      for (const h of file.headings) {
        const sectionId = `section:${file.filePath}:${h.slug}`;
        if (!graph.getNode(sectionId)) {
          graph.addNode({
            id: sectionId,
            label: 'Section',
            properties: {
              name: h.text,
              filePath: file.filePath,
              level: h.level,
              startLine: h.line,
            },
          });
          sectionCount++;
        }
        globalSections.set(`${file.filePath}|${h.slug}`, sectionId);
        sections.push({ slug: h.slug, sectionId });
      }
      // Index with-extension and without-extension for O(1) lookup (#202)
      fileSectionIndex.set(file.filePath, sections);
      const noExt = file.filePath.replace(/\.(md|mdx)$/i, '');
      if (noExt !== file.filePath) {
        fileSectionIndex.set(noExt, sections);
      }
    }

    // Pass 2: Resolve cross-references using the global index (#194)
    for (const file of mdFiles) {
      for (const link of file.links) {
        if (link.target.startsWith('http')) continue;

        // Determine source section (containing section for this link)
        let containingSection: string | null = null;
        for (const h of [...file.headings].reverse()) {
          if (h.line <= link.line) { containingSection = h.slug; break; }
        }

        // #195: If link appears before first heading, use file as source
        const sourceSlug = containingSection ?? (file.headings[0]?.slug ?? '');

        // Parse target: split into file part and anchor part
        const hashIdx = link.target.indexOf('#');
        const targetFile = hashIdx >= 0 ? link.target.slice(0, hashIdx) : link.target;
        const anchor = hashIdx >= 0 ? link.target.slice(hashIdx + 1) : '';

        let resolvedTargetId: string | null = null;

        if (!targetFile || targetFile === file.filePath || link.target.startsWith('#')) {
          // Same-file link — use current file's headings
          const targetSlug = anchor || link.target.replace(/^#/, '');
          resolvedTargetId = globalSections.get(`${file.filePath}|${targetSlug}`) ?? null;
        } else {
          // Cross-file link — resolve relative path keeping it repo-relative (#200)
          const resolvedPath = resolveRelative(dirname(file.filePath), targetFile);
          const sections = lookupSections(resolvedPath, fileSectionIndex);

          if (sections) {
            if (anchor) {
              resolvedTargetId = globalSections.get(`${sections.path}|${anchor}`) ?? null;
            } else {
              resolvedTargetId = sections.entries[0]?.sectionId ?? null;
            }
          }
        }

        if (!resolvedTargetId) continue;

        // #195: If pre-heading link (no containingSection), attach to File node
        const sourceId = containingSection
          ? `section:${file.filePath}:${sourceSlug}`
          : file.id;

        const edgeId = `xref:${sourceId}:to:${resolvedTargetId}`;
        if (graph.getRelationship(edgeId)) continue;

        graph.addRelationship({
          id: edgeId,
          sourceId,
          targetId: resolvedTargetId,
          type: 'USES',
          confidence: 0.6,
          reason: `Markdown link: ${link.text} -> ${link.target}`,
        });
        crossRefCount++;
      }
    }

    return { sectionCount, crossRefCount, fileCount };
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a relative target path from a base directory, keeping the
 * result repo-relative (not absolute). Handles '../' segments (#200).
 */
function resolveRelative(baseDir: string, target: string): string {
  const parts = toPosix(target).split('/');
  const stack = baseDir.split('/').filter((p) => p && p !== '.');

  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      stack.pop();
    } else {
      stack.push(part);
    }
  }

  return stack.join('/');
}

/**
 * Look up sections for a file path. Tries exact match, with .md/.mdx
 * extensions, and without extension. O(1) via pre-built index (#202).
 */
function lookupSections(
  filePath: string,
  index: Map<string, Array<{ slug: string; sectionId: string }>>,
): { path: string; entries: Array<{ slug: string; sectionId: string }> } | null {
  let entries = index.get(filePath);
  if (entries) return { path: filePath, entries };

  for (const ext of ['.md', '.mdx']) {
    entries = index.get(filePath + ext);
    if (entries) return { path: filePath + ext, entries };
  }

  const stripped = filePath.replace(/\.(md|mdx)$/i, '');
  entries = index.get(stripped);
  if (entries) return { path: stripped, entries };

  return null;
}
