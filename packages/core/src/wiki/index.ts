/**
 * LLM-Powered Wiki Generation (#269)
 *
 * Generates per-module documentation from the knowledge graph using
 * LLM for module descriptions (when available) or community names
 * for basic offline mode.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import type { KnowledgeGraph } from '../core/types.js';
import { generateHtmlViewer } from './html-viewer.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger({ level: 'info' });
export { generateHtmlViewer } from './html-viewer.js';

export interface WikiMeta {
  lastCommit: string;
  modules: Record<string, string[]>;
}

export interface WikiOptions {
  repoPath: string;
  repoName: string;
  graph: KnowledgeGraph;
  /** LLM model name (default: gpt-4o-mini). */
  model?: string;
  /** LLM API base URL. */
  baseUrl?: string;
  /** LLM API key. */
  apiKey?: string;
  /** Force full regeneration (clears existing wiki). */
  force?: boolean;
  /** Stop after module tree creation (review mode). */
  review?: boolean;
  /** Resume from edited module tree. */
  resume?: boolean;
  /** Publish wiki to GitHub Gist after generation. */
  gist?: boolean;
}

const WIKI_META_FILE = 'meta.json';

function getWikiMetaPath(repoPath: string): string {
  return join(repoPath, '.astrolabe', 'wiki', WIKI_META_FILE);
}

function loadWikiMeta(repoPath: string): WikiMeta | null {
  const metaPath = getWikiMetaPath(repoPath);
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8')) as WikiMeta;
  } catch {
    return null;
  }
}

function saveWikiMeta(repoPath: string, meta: WikiMeta): void {
  const metaPath = getWikiMetaPath(repoPath);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

function getCurrentCommit(repoPath: string): string | null {
  try {
    const commit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
    return commit || null;
  } catch {
    return null;
  }
}

function getChangedFiles(repoPath: string): string[] | null {
  try {
    const diff = execSync('git diff HEAD~1..HEAD --name-only', { cwd: repoPath, encoding: 'utf-8' }).trim();
    return diff ? diff.split('\n').filter(Boolean) : [];
  } catch {
    return null;
  }
}

function getAffectedModules(meta: WikiMeta, changedFiles: string[]): string[] | null {
  if (!changedFiles.length) return [];
  const affected = new Set<string>();
  for (const file of changedFiles) {
    for (const [module, files] of Object.entries(meta.modules)) {
      if (files.includes(file)) affected.add(module);
    }
  }
  return Array.from(affected);
}

export interface WikiResult {
  pageCount: number;
  moduleCount: number;
  overviewPath: string;
  /** Path to the self-contained HTML viewer (#435). */
  htmlPath: string;
  /** URL of the published GitHub Gist (set when gist option is used). */
  gistUrl?: string;
}

function callLlm(prompt: string, opts: WikiOptions, moduleName: string): Promise<string> {
  // #355: Only use OpenAI-compatible keys (OPENAI_API_KEY or explicit --api-key)
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY || '';
  if (!apiKey) return Promise.resolve('');

  const url = opts.baseUrl || 'https://api.openai.com/v1/chat/completions';
  const model = opts.model || 'gpt-4o-mini';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000); // #356: 30s timeout

  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.3,
    }),
    signal: controller.signal,
  })
    .then((r) => {
      clearTimeout(timeout);
      // #356: Check HTTP status before parsing
      if (!r.ok) throw new Error(`LLM API error: ${r.status} ${r.statusText}`);
      return r.json();
    })
    .then((data: any) => data.choices?.[0]?.message?.content || '')
    .catch((e) => {
      clearTimeout(timeout);
      if ((e as Error).name === 'AbortError') {
        log.warn('LLM call timed out', { moduleName });
      }
      return '';
    });
}

async function generateModuleDescription(
  moduleName: string,
  symbols: string[],
  opts: WikiOptions,
): Promise<string> {
  if (!opts.apiKey && !process.env.OPENAI_API_KEY) {
    // #355: Offline mode — only OPENAI_API_KEY supported (not Anthropic)
    return `The **${moduleName}** module contains ${symbols.length} key symbols and handles functionality related to ${moduleName.replace(/-/g, ' ')}.\n\nKey symbols: ${symbols.slice(0, 10).map((s) => `\`${s}\``).join(', ')}.`;
  }

  const prompt = `Write a 2-3 sentence description of a software module named "${moduleName}" containing these symbols: ${symbols.slice(0, 15).join(', ')}. Focus on the module's purpose and what it provides. Be concise.`;
  return callLlm(prompt, opts, moduleName);
}

export async function generateWiki(opts: WikiOptions): Promise<WikiResult> {
  const wikiDir = join(opts.repoPath, '.astrolabe', 'wiki');
  const { graph } = opts;

  // Clean existing wiki if forced
  if (opts.force && existsSync(wikiDir)) {
    rmSync(wikiDir, { recursive: true, force: true });
  }

  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });

  // Build communities from module tree (resume) or graph
  const communities = new Map<string, string[]>();
  let prebuiltModuleFiles: Record<string, string[]> | null = null;

  if (opts.resume) {
    const treePath = join(wikiDir, 'module_tree.json');
    if (!existsSync(treePath)) {
      throw new Error('[wiki] Cannot resume: module_tree.json not found. Run with --review first.');
    }
    const tree = JSON.parse(readFileSync(treePath, 'utf-8')) as {
      modules: Record<string, { symbols: string[]; files: string[] }>;
    };
    const loadedFiles: Record<string, string[]> = {};
    for (const [modName, data] of Object.entries(tree.modules)) {
      communities.set(modName, data.symbols);
      loadedFiles[modName] = data.files;
    }
    prebuiltModuleFiles = loadedFiles;
  } else {
    const memberOf = new Map<string, string>();
    for (const rel of graph.iterRelationships()) {
      if (rel.type === 'MEMBER_OF') {
        const target = graph.getNode(rel.targetId);
        if (target) memberOf.set(rel.sourceId, (target.properties.name as string) ?? target.id);
      }
    }

    for (const node of graph.iterNodes()) {
      if (node.label === 'Community') {
        const name = (node.properties.name as string) ?? node.id;
        if (!communities.has(name)) communities.set(name, []);
      } else if (['Function', 'Class', 'Method', 'Interface'].includes(node.label)) {
        const cName = memberOf.get(node.id);
        if (cName) {
          if (!communities.has(cName)) communities.set(cName, []);
          communities.get(cName)!.push((node.properties.name as string) ?? node.id);
        }
      }
    }

    // Review mode: write module tree and return early
    if (opts.review) {
      // #472: Build symbol→file lookup once for review mode
      const symbolToFile = new Map<string, string>();
      for (const node of graph.iterNodes()) {
        const symName = node.properties.name as string;
        const srcFile = node.properties.sourceFile as string | undefined;
        if (symName && srcFile) symbolToFile.set(symName, srcFile);
      }

      const moduleTreeData: Record<string, { symbols: string[]; files: string[] }> = {};
      for (const [modName, symbols] of communities) {
        const filesForModule: string[] = [];
        for (const symbol of symbols) {
          const sf = symbolToFile.get(symbol);
          if (sf && !filesForModule.includes(sf)) filesForModule.push(sf);
        }
        moduleTreeData[modName] = { symbols, files: filesForModule };
      }
      const treePath = join(wikiDir, 'module_tree.json');
      writeFileSync(treePath, JSON.stringify({ modules: moduleTreeData }, null, 2), 'utf-8');
      console.log('[wiki] Review mode: module tree written to .astrolabe/wiki/module_tree.json. Edit and re-run with --resume.');
      return { pageCount: 0, moduleCount: communities.size, overviewPath: '', htmlPath: '' };
    }
  }

  // #472: Build symbol→file lookup once (O(N)) for file collection in generation loop
  const symbolToFile = new Map<string, string>();
  for (const node of graph.iterNodes()) {
    const symName = node.properties.name as string;
    const srcFile = node.properties.sourceFile as string | undefined;
    if (symName && srcFile) symbolToFile.set(symName, srcFile);
  }

  // Determine which modules to regenerate (incremental mode)
  let modulesToRegenerate: string[] | null = null;
  if (!opts.force) {
    const currentCommit = getCurrentCommit(opts.repoPath);
    const meta = loadWikiMeta(opts.repoPath);
    if (meta && currentCommit && meta.lastCommit) {
      const changedFiles = getChangedFiles(opts.repoPath);
      if (changedFiles !== null) {
        modulesToRegenerate = getAffectedModules(meta, changedFiles);
        if (modulesToRegenerate?.length) {
          console.log(`[wiki] Incremental mode: regenerating ${modulesToRegenerate.length} affected module(s)`);
        }
      }
    }
  }

  let pageCount = 0;
  const usedNames = new Set<string>(); // #357: collision-safe naming
  const safeNameMap = new Map<string, string>(); // #416: track safeName per community

  // Build module-to-files mapping for meta.json
  const moduleFilesMap: Record<string, string[]> = {};

  // Generate per-module pages
  for (const [name, symbols] of communities) {
    let safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    // #357: ensure uniqueness — append short hash if name collides
    if (usedNames.has(safeName)) {
      let hash = 0;
      for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i) | 0;
      safeName += '_' + Math.abs(hash).toString(16).slice(0, 6);
    }
    usedNames.add(safeName);
    safeNameMap.set(name, safeName); // #416: remember for overview

    // Skip non-affected modules in incremental mode
    if (modulesToRegenerate !== null && !modulesToRegenerate.includes(name)) continue;

    // Collect source files for this module's symbols
    const filesForModule: string[] = prebuiltModuleFiles && prebuiltModuleFiles[name]
      ? prebuiltModuleFiles[name]
      : (() => {
          const files: string[] = [];
          for (const symbol of symbols) {
            const sf = symbolToFile.get(symbol);
            if (sf && !files.includes(sf)) files.push(sf);
          }
          return files;
        })();
    moduleFilesMap[name] = filesForModule;

    const description = await generateModuleDescription(name, symbols, opts);

    const content = [
      `# ${name}\n`,
      `> Auto-generated by Astrolabe Wiki | ${new Date().toISOString().split('T')[0]}\n`,
      `\n## Overview\n`,
      description,
      `\n## Key Symbols (${symbols.length})\n`,
      ...symbols.slice(0, 30).map((s) => `- \`${s}\``),
      `\n## Dependencies\n`,
      `_See cross-module links in the overview page._`,
    ].join('\n');

    writeFileSync(join(wikiDir, `${safeName}.md`), content, 'utf-8');
    pageCount++;
  }

  // Generate overview page
  const overviewLines = [
    `# ${opts.repoName} — Codebase Wiki\n`,
    `> Auto-generated by Astrolabe | ${new Date().toISOString().split('T')[0]}\n`,
    `\n## Modules (${communities.size})\n`,
  ];

  for (const [name, symbols] of communities) {
    const safeName = safeNameMap.get(name) ?? name.replace(/[^a-zA-Z0-9_-]/g, '_'); // #416: use same safeName as per-module page
    overviewLines.push(`- [${name}](${safeName}.md) — ${symbols.length} symbols`);
  }

  overviewLines.push(
    `\n## Index Stats\n`,
    `- Total symbols: ${graph.nodeCount}`,
    `- Total relationships: ${graph.relationshipCount}`,
    `- Communities: ${communities.size}`,
    `\n## Cross-References\n`,
    `Use \`astrolabe context <symbol>\` for 360-degree views of any symbol.`,
  );

  writeFileSync(join(wikiDir, 'README.md'), overviewLines.join('\n'), 'utf-8');

  // Save meta.json with current commit and module-file mapping
  const currentCommit = getCurrentCommit(opts.repoPath);
  if (currentCommit) {
    saveWikiMeta(opts.repoPath, { lastCommit: currentCommit, modules: moduleFilesMap });
  }

  // Generate self-contained HTML viewer (#435)
  const htmlPath = generateHtmlViewer(wikiDir, opts.repoName);

  // Gist publishing
  let gistUrl: string | undefined;
  if (opts.gist) {
    try {
      const wikiFiles = readdirSync(wikiDir)
        .filter((f) => f.endsWith('.md') || f.endsWith('.html'))
        .map((f) => join(wikiDir, f));
      if (wikiFiles.length > 0) {
        // #474: Use execFileSync to avoid command injection via filenames
        const output = execFileSync('gh', ['gist', 'create', ...wikiFiles], {
          encoding: 'utf-8',
          cwd: opts.repoPath,
        }).trim();
        const urlMatch = output.match(/https:\/\/gist\.github\.com\/\S+/);
        if (urlMatch) {
          gistUrl = urlMatch[0];
          console.log(`[wiki] Published to GitHub Gist: ${gistUrl}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('Gist publishing failed', { error: msg });
    }
  }

  return { pageCount, moduleCount: communities.size, overviewPath: join(wikiDir, 'README.md'), htmlPath, gistUrl };
}
