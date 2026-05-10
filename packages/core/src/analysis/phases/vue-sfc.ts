/**
 * Pipeline Phase: Vue Single File Component extraction (#730)
 *
 * Regex-based `.vue` file parser that extracts `<template>`, `<script>`,
 * `<script setup>`, `<style>`, and `<style scoped>` blocks as separate
 * logical nodes with proper relationships.
 *
 * For `<script setup>` blocks the phase also extracts top-level imports
 * and export-like declarations (composition API patterns) using simple
 * regex — no AST dependency required.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import { getPhaseOutput } from '../../core/pipeline.js';
import type { ScanOutput } from '../phases/scan.js';
import { createLogger } from '../../logging/index.js';

const log = createLogger({ level: 'debug' });

// ── Output type ─────────────────────────────────────────────────────────────

export interface VueSfcOutput {
  /** Number of Vue components discovered. */
  componentCount: number;
  /** Total blocks extracted across all components. */
  blockCount: number;
  /** Number of import references found in `<script setup>` blocks. */
  importCount: number;
}

// ── Regex patterns ──────────────────────────────────────────────────────────

/**
 * Matches Vue SFC top-level blocks: `<template>`, `<script>`, `<style>`.
 * Captures: (1) tag name, (2) attribute string (may be empty), (3) inner content.
 */
const VUE_BLOCK_RE = /<(template|script|style)([^>]*)>([\s\S]*?)<\/\1>/gi;

/** Detect `setup` attribute on `<script>` tags. */
const SETUP_ATTR_RE = /\bsetup\b/;

/** Detect `scoped` attribute on `<style>` tags. */
const SCOPED_ATTR_RE = /\bscoped\b/;

/** Detect `lang` attribute value. */
const LANG_ATTR_RE = /\blang\s*=\s*["']?(\w+)/;

/** ES-module import statement (simplified). */
const IMPORT_RE = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*)\s+from\s+['"]([^'"]+)['"]/g;

/** Top-level `export default` or named exports in `<script setup>`. */
const EXPORT_RE = /export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type)\s+(\w+)/g;

// ── Block classification ────────────────────────────────────────────────────

interface VueBlock {
  tag: 'template' | 'script' | 'style';
  attrs: string;
  content: string;
  isSetup: boolean;
  isScoped: boolean;
  lang: string | null;
}

function extractBlocks(source: string): VueBlock[] {
  const blocks: VueBlock[] = [];
  for (const m of source.matchAll(VUE_BLOCK_RE)) {
    const tag = m[1] as 'template' | 'script' | 'style';
    const attrs = m[2] ?? '';
    const content = m[3] ?? '';
    blocks.push({
      tag,
      attrs,
      content,
      isSetup: tag === 'script' && SETUP_ATTR_RE.test(attrs),
      isScoped: tag === 'style' && SCOPED_ATTR_RE.test(attrs),
      lang: LANG_ATTR_RE.exec(attrs)?.[1] ?? null,
    });
  }
  return blocks;
}

// ── Phase ───────────────────────────────────────────────────────────────────

export const vueSfcPhase: PhaseDefinition<VueSfcOutput> = {
  name: 'vue-sfc',
  dependencies: ['scan', 'structure'],

  execute(context: PhaseContext): VueSfcOutput {
    const scanOutput = getPhaseOutput<ScanOutput>(context, 'scan');
    const { graph } = context;
    let componentCount = 0;
    let blockCount = 0;
    let importCount = 0;

    const vueFiles = scanOutput?.files?.filter(
      (f) => /\.vue$/i.test(f.path),
    ) ?? [];

    if (vueFiles.length === 0) {
      return { componentCount: 0, blockCount: 0, importCount: 0 };
    }

    for (const file of vueFiles) {
      let source: string;
      try {
        source = readFileSync(file.path, 'utf-8');
      } catch (err) {
        log.debug('Skipping unreadable Vue file', { file: file.path, error: String(err) });
        continue;
      }

      const componentName = basename(file.path, '.vue');
      const componentId = `vue:component:${file.path}:${componentName}`;

      // Create parent VueComponent node (uses File label with vueComponent kind).
      if (!graph.getNode(componentId)) {
        graph.addNode({
          id: componentId,
          label: 'File',
          properties: {
            name: componentName,
            filePath: file.path,
            kind: 'VueComponent',
            language: 'vue',
          },
        });
        componentCount++;
      }

      const blocks = extractBlocks(source);

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const blockId = `vue:block:${file.path}:${componentName}:${block.tag}:${i}`;

        if (!graph.getNode(blockId)) {
          graph.addNode({
            id: blockId,
            label: 'CodeElement',
            properties: {
              name: `<${block.tag}>`,
              filePath: file.path,
              kind: `Vue${capitalize(block.tag)}Block`,
              language: block.lang ?? (block.tag === 'template' ? 'html' : block.tag === 'style' ? 'css' : 'javascript'),
              isSetup: block.isSetup || undefined,
              isScoped: block.isScoped || undefined,
              lineCount: block.content.split('\n').length,
            },
          });
          blockCount++;
        }

        // CONTAINS edge from component → block.
        const edgeId = `vue:contains:${componentId}:${blockId}`;
        if (!graph.getRelationship(edgeId)) {
          graph.addRelationship({
            id: edgeId,
            sourceId: componentId,
            targetId: blockId,
            type: 'CONTAINS',
            confidence: 1.0,
            reason: `Vue SFC block <${block.tag}> in ${componentName}.vue`,
          });
        }

        // For <script setup>, extract imports and exports.
        if (block.isSetup) {
          for (const imp of block.content.matchAll(IMPORT_RE)) {
            const importSource = imp[1];
            const importId = `vue:import:${file.path}:${componentName}:${importSource}`;
            if (!graph.getNode(importId)) {
              graph.addNode({
                id: importId,
                label: 'Import',
                properties: {
                  name: importSource,
                  filePath: file.path,
                  kind: 'VueSfcImport',
                  source: importSource,
                },
              });
              importCount++;
            }

            const importEdgeId = `vue:imports:${blockId}:${importSource}`;
            if (!graph.getRelationship(importEdgeId)) {
              graph.addRelationship({
                id: importEdgeId,
                sourceId: blockId,
                targetId: importId,
                type: 'IMPORTS',
                confidence: 0.9,
                reason: `import from '${importSource}' in <script setup> of ${componentName}.vue`,
              });
            }
          }

          for (const exp of block.content.matchAll(EXPORT_RE)) {
            const exportName = exp[1];
            const exportId = `vue:export:${file.path}:${componentName}:${exportName}`;
            if (!graph.getNode(exportId)) {
              graph.addNode({
                id: exportId,
                label: 'CodeElement',
                properties: {
                  name: exportName,
                  filePath: file.path,
                  kind: 'VueSfcExport',
                  isExported: true,
                },
              });
            }

            const exportEdgeId = `vue:defines:${blockId}:${exportName}`;
            if (!graph.getRelationship(exportEdgeId)) {
              graph.addRelationship({
                id: exportEdgeId,
                sourceId: blockId,
                targetId: exportId,
                type: 'DEFINES',
                confidence: 0.9,
                reason: `export '${exportName}' in <script setup> of ${componentName}.vue`,
              });
            }
          }
        }
      }
    }

    return { componentCount, blockCount, importCount };
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
