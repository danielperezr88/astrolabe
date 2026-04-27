/**
 * Pipeline Phase: Markdown Document Parsing
 *
 * Parses .md and .mdx files to extract headings, cross-links,
 * and code references. Creates Section nodes and cross-reference edges.
 *
 * Dependencies: structure (needs file list)
 * Output: Section nodes + CROSS_REFERENCES edges
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

export interface MarkdownOutput {
  sectionCount: number;
  crossRefCount: number;
  fileCount: number;
}

export const markdownPhase: PhaseDefinition<MarkdownOutput> = {
  name: 'markdown',
  dependencies: ['structure'],

  execute(context: PhaseContext): MarkdownOutput {
    const { graph } = context;
    let sectionCount = 0;
    let crossRefCount = 0;
    let fileCount = 0;

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

      try {
        const content = readFileSync(join(context.repoPath, fp), 'utf-8');
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
    for (const file of mdFiles) {
      if (file.headings.length === 0) continue;
      fileCount++;

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
          // Cross-file link — resolve relative path to full file path (#194)
          const resolvedPath = resolve(dirname(file.filePath), targetFile).replace(/\\/g, '/');
          // Try exact path match and extensionless match
          let actualRelPath = resolvedPath;
          if (!globalSections.has(`${resolvedPath}|${anchor || 'dummy'}`)) {
            // Try without extension
            const extMatch = actualRelPath.match(/\.(md|mdx)$/i);
            const basePath = extMatch ? actualRelPath.slice(0, -extMatch[0].length) : actualRelPath;

            // Search for matching file in global sections
            for (const [key, id] of globalSections) {
              const [fp] = key.split('|');
              const fpNoExt = fp.replace(/\.(md|mdx)$/i, '');
              if (fp === basePath || fpNoExt === basePath) {
                const targetSlug = anchor || '';
                if (targetSlug) {
                  const maybeId = globalSections.get(`${fp}|${targetSlug}`);
                  if (maybeId) { resolvedTargetId = maybeId; break; }
                } else {
                  // No anchor — link to first heading in target file
                  resolvedTargetId = id;
                  break;
                }
              }
            }
          } else {
            resolvedTargetId = globalSections.get(`${resolvedPath}|${anchor}`) ?? null;
          }
        }

        if (!resolvedTargetId) continue;

        // #195: If pre-heading link (no containingSection), attach to File node
        const sourceId = containingSection
          ? `section:${file.filePath}:${sourceSlug}`
          : file.id; // Use File node as source for links before first heading

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
