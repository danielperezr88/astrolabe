/**
 * Tests for Vue SFC phase (#730) — regex-based Vue component extraction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledgeGraph } from '../../../src/core/graph.js';
import { createPhaseContext } from '../../../src/core/pipeline.js';
import { vueSfcPhase } from '../../../src/analysis/phases/vue-sfc.js';

let testDir: string;

function makeContext(graph: any, filePaths: string[]) {
  const ctx = createPhaseContext(testDir, graph, () => {});
  ctx.state.set('output:scan', {
    files: filePaths.map((fp) => ({
      path: join(testDir, fp),
      hash: 'abc',
      ext: fp.split('.').pop() || '',
      size: 100,
      language: 'vue' as any,
      extension: fp.split('.').pop() || '',
      absolutePath: join(testDir, fp),
    })),
    directoryCount: 1,
  });
  return ctx;
}

describe('Vue SFC Phase (#730)', () => {
  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'astrolabe-vue-'));
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('extracts template, script, and style blocks from a Vue SFC', () => {
    writeFileSync(join(testDir, 'App.vue'), `
<template>
  <div class="app">
    <h1>{{ title }}</h1>
  </div>
</template>

<script>
export default {
  data() {
    return { title: 'Hello' };
  },
};
</script>

<style>
.app { color: red; }
</style>
`, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['App.vue']);

    const result = vueSfcPhase.execute(ctx) as any;
    expect(result.componentCount).toBe(1);
    expect(result.blockCount).toBe(3);

    // Check parent component node
    const componentId = `vue:component:${join(testDir, 'App.vue')}:App`;
    const componentNode = graph.getNode(componentId);
    expect(componentNode).toBeDefined();
    expect(componentNode!.label).toBe('File');
    expect(componentNode!.properties.kind).toBe('VueComponent');
    expect(componentNode!.properties.language).toBe('vue');

    // Check block nodes exist
    const allNodes = graph.nodes;
    const blockNodes = allNodes.filter((n) => n.label === 'CodeElement');
    expect(blockNodes.length).toBe(3);

    const kinds = blockNodes.map((n) => n.properties.kind).sort();
    expect(kinds).toEqual(['VueScriptBlock', 'VueStyleBlock', 'VueTemplateBlock']);
  });

  it('detects <script setup> and extracts imports', () => {
    writeFileSync(join(testDir, 'Setup.vue'), `
<template>
  <button @click="increment">{{ count }}</button>
</template>

<script setup>
import { ref } from 'vue';
import MyButton from './MyButton.vue';

const count = ref(0);
function increment() {
  count.value++;
}
</script>
`, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['Setup.vue']);

    const result = vueSfcPhase.execute(ctx) as any;
    expect(result.componentCount).toBe(1);
    expect(result.blockCount).toBe(2); // template + script setup
    expect(result.importCount).toBe(2);

    // Verify import nodes
    const importNodes = graph.nodes.filter((n) => n.label === 'Import');
    expect(importNodes.length).toBe(2);

    const importSources = importNodes.map((n) => n.properties.source).sort();
    expect(importSources).toEqual(['./MyButton.vue', 'vue']);
  });

  it('detects <style scoped> blocks', () => {
    writeFileSync(join(testDir, 'ScopedStyle.vue'), `
<template>
  <p>Scoped</p>
</template>

<style scoped>
p { color: blue; }
</style>
`, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['ScopedStyle.vue']);

    const result = vueSfcPhase.execute(ctx) as any;
    expect(result.blockCount).toBe(2);

    const styleBlock = graph.nodes.find(
      (n) => n.label === 'CodeElement' && n.properties.kind === 'VueStyleBlock',
    );
    expect(styleBlock).toBeDefined();
    expect(styleBlock!.properties.isScoped).toBe(true);
  });

  it('handles multiple <style> blocks', () => {
    writeFileSync(join(testDir, 'MultiStyle.vue'), `
<template><span>test</span></template>

<style>
span { display: block; }
</style>

<style scoped>
span { color: green; }
</style>
`, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['MultiStyle.vue']);

    const result = vueSfcPhase.execute(ctx) as any;
    expect(result.blockCount).toBe(3); // 1 template + 2 style

    const styleBlocks = graph.nodes.filter(
      (n) => n.label === 'CodeElement' && n.properties.kind === 'VueStyleBlock',
    );
    expect(styleBlocks.length).toBe(2);
  });

  it('creates CONTAINS edges from component to blocks', () => {
    writeFileSync(join(testDir, 'Edges.vue'), `
<template><div>edges</div></template>
<script>export default {}</script>
<style scoped>div {}</style>
`, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['Edges.vue']);

    vueSfcPhase.execute(ctx);

    const containsEdges = graph.relationships.filter((r) => r.type === 'CONTAINS');
    expect(containsEdges.length).toBe(3); // component → template, script, style

    for (const edge of containsEdges) {
      expect(edge.confidence).toBe(1.0);
      expect(edge.reason).toContain('Vue SFC block');
    }
  });

  it('extracts exports from <script setup>', () => {
    writeFileSync(join(testDir, 'Exports.vue'), `
<template><div>exports</div></template>

<script setup>
export const TITLE = 'Hello';
export function greet() { return TITLE; }
</script>
`, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['Exports.vue']);

    const result = vueSfcPhase.execute(ctx) as any;
    expect(result.componentCount).toBe(1);

    // Check export nodes
    const exportNodes = graph.nodes.filter(
      (n) => n.properties.kind === 'VueSfcExport',
    );
    expect(exportNodes.length).toBe(2);

    const names = exportNodes.map((n) => n.properties.name).sort();
    expect(names).toEqual(['TITLE', 'greet']);

    // Check DEFINES edges
    const definesEdges = graph.relationships.filter((r) => r.type === 'DEFINES');
    expect(definesEdges.length).toBe(2);
  });

  it('skips non-Vue files', () => {
    writeFileSync(join(testDir, 'main.ts'), `
export function hello() { return 'world'; }
`, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['main.ts']);

    const result = vueSfcPhase.execute(ctx) as any;
    expect(result.componentCount).toBe(0);
    expect(result.blockCount).toBe(0);
    expect(result.importCount).toBe(0);
  });

  it('handles empty scan output', () => {
    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, []);

    const result = vueSfcPhase.execute(ctx) as any;
    expect(result.componentCount).toBe(0);
    expect(result.blockCount).toBe(0);
    expect(result.importCount).toBe(0);
  });

  it('handles Vue files with only a template block', () => {
    writeFileSync(join(testDir, 'TemplateOnly.vue'), `
<template>
  <p>Just a template</p>
</template>
`, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['TemplateOnly.vue']);

    const result = vueSfcPhase.execute(ctx) as any;
    expect(result.componentCount).toBe(1);
    expect(result.blockCount).toBe(1);
    expect(result.importCount).toBe(0);
  });

  it('detects lang attribute on blocks', () => {
    writeFileSync(join(testDir, 'Langs.vue'), `
<template><div>langs</div></template>

<script setup lang="ts">
import { ref } from 'vue';
const count = ref<number>(0);
</script>

<style lang="scss">
div { color: red; }
</style>
`, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['Langs.vue']);

    vueSfcPhase.execute(ctx);

    const blockNodes = graph.nodes.filter((n) => n.label === 'CodeElement');

    const scriptBlock = blockNodes.find((n) => n.properties.kind === 'VueScriptBlock');
    expect(scriptBlock).toBeDefined();
    expect(scriptBlock!.properties.language).toBe('ts');
    expect(scriptBlock!.properties.isSetup).toBe(true);

    const styleBlock = blockNodes.find((n) => n.properties.kind === 'VueStyleBlock');
    expect(styleBlock).toBeDefined();
    expect(styleBlock!.properties.language).toBe('scss');
  });

  it('handles multiple Vue files', () => {
    writeFileSync(join(testDir, 'CompA.vue'), `
<template><span>A</span></template>
<script>export default {}</script>
`, 'utf-8');

    writeFileSync(join(testDir, 'CompB.vue'), `
<template><span>B</span></template>
<script setup lang="ts">
import { ref } from 'vue';
</script>
`, 'utf-8');

    const graph = createKnowledgeGraph();
    const ctx = makeContext(graph, ['CompA.vue', 'CompB.vue']);

    const result = vueSfcPhase.execute(ctx) as any;
    expect(result.componentCount).toBe(2);
    expect(result.blockCount).toBe(4); // 2 per file
    expect(result.importCount).toBe(1); // only CompB has a script setup import
  });
});
