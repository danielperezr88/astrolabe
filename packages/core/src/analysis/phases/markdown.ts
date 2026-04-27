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
import { join } from 'node:path';
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

    // Find .md and .mdx files
    const mdFiles: Array<{ id: string; filePath: string }> = [];
    for (const node of graph.iterNodes()) {
      if (node.label !== 'File') continue;
      const fp = node.properties.filePath as string | undefined;
      if (fp && /\.(md|mdx)$/i.test(fp)) {
        mdFiles.push({ id: node.id, filePath: fp });
      }
    }

    for (const file of mdFiles) {
      try {
        const content = readFileSync(join(context.repoPath, file.filePath), 'utf-8');
        const headings: Array<{ level: number; text: string; line: number; slug: string }> = [];
        const links: Array<{ text: string; target: string; line: number }> = [];

        // Extract headings and links
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Headings: # Title, ## Section, etc.
          const hMatch = line.match(/^(#{1,6})\s+(.+)/);
          if (hMatch) {
            const level = hMatch[1].length;
            const text = hMatch[2].trim().replace(/[#*`\[\]]/g, '');
            const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            headings.push({ level, text, line: i + 1, slug });
          }
          // Links: [text](target) and [text](target#anchor)
          const lRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
          let lMatch;
          while ((lMatch = lRegex.exec(line)) !== null) {
            links.push({ text: lMatch[1], target: lMatch[2].split('#')[0], line: i + 1 });
          }
        }

        if (headings.length === 0) continue;
        fileCount++;

        // Create Section nodes for headings
        for (const h of headings) {
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
        }

        // Create cross-reference edges for internal links
        for (const link of links) {
          if (link.target.startsWith('http')) continue; // Skip external
          // Try to find target section
          for (const h of headings) {
            if (`./${link.target}` === `./${file.filePath}` ||
                link.target === h.slug ||
                link.target.endsWith(`#${h.slug}`)) {
              const sourceSlug = headings.find(() => true)?.slug ?? '';
              const edgeId = `xref:${file.filePath}:${link.text}:${h.slug}`;
              if (!graph.getRelationship(edgeId)) {
                graph.addRelationship({
                  id: edgeId,
                  sourceId: `section:${file.filePath}:${sourceSlug || 'top'}`,
                  targetId: `section:${file.filePath}:${h.slug}`,
                  type: 'USES',
                  confidence: 0.6,
                  reason: `Markdown link: ${link.text} -> ${link.target}`,
                });
                crossRefCount++;
              }
              break;
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return { sectionCount, crossRefCount, fileCount };
  },
};
