/**
 * Astrolabe — Vue Single-File Component (SFC) support (#395).
 *
 * Vue SFCs are preprocessed to extract the `<script>` block content,
 * which is then parsed as TypeScript. This module provides:
 *
 * - SFC preprocessing: extracts `<script>` / `<script setup>` content
 * - Built-in Vue composable/API function names for detection
 */

import { readFileSync } from 'node:fs';

// ── SFC preprocessing ──────────────────────────────────────────────────────

/**
 * Extract the `<script>` block content from a Vue SFC.
 * Returns the TypeScript/JavaScript content and whether it's `<script setup>`.
 *
 * @returns Script content and setup flag, or null if no script block found.
 */
export function preprocessVueSfc(filePath: string, content?: string): { content: string; isSetup: boolean } | null {
  let source: string;
  if (content !== undefined) {
    source = content;
  } else {
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
  return extractScriptContent(source);
}

function extractScriptContent(source: string): { content: string; isSetup: boolean } | null {
  // Try <script setup lang="ts"> or <script setup> first
  const setupMatch = source.match(/<script\s+setup(?:\s+lang=["'][^"']*["'])?\s*>\s*([\s\S]*?)<\/script>/);
  if (setupMatch) {
    return { content: setupMatch[1].trim(), isSetup: true };
  }
  // Try regular <script lang="ts"> or <script>
  const normalMatch = source.match(/<script(?:\s+lang=["'][^"']*["'])?\s*>\s*([\s\S]*?)<\/script>/);
  if (normalMatch) {
    return { content: normalMatch[1].trim(), isSetup: false };
  }
  return null;
}

// ── Built-in Vue composable/API function names ─────────────────────────────

export const VUE_BUILT_INS = new Set([
  'ref', 'reactive', 'computed', 'shallowRef', 'triggerRef',
  'toRef', 'toRefs', 'unref', 'isRef', 'isReactive', 'isReadonly',
  'watch', 'watchEffect', 'watchPostEffect', 'watchSyncEffect',
  'onMounted', 'onUnmounted', 'onBeforeMount', 'onBeforeUnmount',
  'onUpdated', 'onBeforeUpdate', 'onActivated', 'onDeactivated',
  'onErrorCaptured', 'onServerPrefetch',
  'defineProps', 'defineEmits', 'defineExpose', 'defineOptions',
  'defineSlots', 'defineModel', 'withDefaults',
  'provide', 'inject',
  'nextTick',
  'useSlots', 'useAttrs', 'useRouter', 'useRoute', 'useStore',
]);
