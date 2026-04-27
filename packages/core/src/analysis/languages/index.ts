/**
 * Astrolabe — Language registry.
 *
 * Maps file extensions to {@link LanguageDefinition} instances
 * and provides a central place to look up which language to use
 * for a given file.
 */

import type { LanguageDefinition } from '../language-definition.js';
import { javascriptLanguage } from './javascript.js';
import { typescriptLanguage, tsxLanguage } from './typescript.js';
import { pythonLanguage } from './python.js';
import { goLanguage } from './go.js';
import { rustLanguage } from './rust.js';

/**
 * All registered language definitions.
 * Add new languages here when they are implemented.
 */
const allLanguages: LanguageDefinition[] = [
  javascriptLanguage,
  typescriptLanguage,
  tsxLanguage,
  pythonLanguage,
  goLanguage,
  rustLanguage,
];

/**
 * Extension → LanguageDefinition lookup table.
 * Built at import time — O(1) lookup.
 */
const extensionIndex = new Map<string, LanguageDefinition>();

for (const lang of allLanguages) {
  for (const ext of lang.extensions) {
    // Last definition wins if extensions overlap (prefer more-specific)
    extensionIndex.set(ext, lang);
  }
}

/**
 * Look up the language definition for a given file extension.
 *
 * @param extension  File extension — **must** include the leading dot
 *                   (e.g. `'.ts'`, `'.js'`, `'.py'`).
 * @returns The matching language definition, or `undefined` if the
 *          extension is not recognised.
 */
export function languageForExtension(extension: string): LanguageDefinition | undefined {
  return extensionIndex.get(extension);
}

/**
 * Look up the language definition for a given file path.
 *
 * @param filePath  File path (absolute or relative).
 * @returns The matching language definition, or `undefined`.
 */
export function languageForFile(filePath: string): LanguageDefinition | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return undefined;
  const ext = filePath.slice(dot).toLowerCase();
  return extensionIndex.get(ext);
}

/**
 * All registered language definitions.
 */
export function getAllLanguages(): readonly LanguageDefinition[] {
  return allLanguages;
}

/**
 * List of all file extensions handled across all languages.
 */
export function getAllExtensions(): string[] {
  return Array.from(extensionIndex.keys());
}
