/**
 * Skill generation for AI assistants.
 *
 * Generates a Markdown skill file that describes how to use Astrolabe
 * as part of an AI assistant's toolset. The skill file can be ingested
 * by LLM-based tool dispatchers to integrate codebase analysis into
 * their workflow.
 *
 * Usage: npx @astrolabe/cli generate-skill [--output astrolabe-skill.md]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllExtensions, languageForExtension } from '../analysis/parser.js';

/**
 * Build a dynamic list of supported languages from the language registry (#112).
 * Groups extensions by language name for a readable output.
 */
function buildLanguageList(): string {
  const exts = getAllExtensions();
  const byLang = new Map<string, Set<string>>();
  for (const ext of exts) {
    const lang = languageForExtension(ext);
    const name = lang ? lang.name : ext;
    let group = byLang.get(name);
    if (!group) { group = new Set(); byLang.set(name, group); }
    group.add(ext);
  }
  return Array.from(byLang.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lang, extensions]) => {
      const extList = Array.from(extensions).sort().join(', ');
      return `- ${lang} (${extList})`;
    })
    .join('\n');
}

function skillTemplate(version: string): string {
  const languageList = buildLanguageList();
  return `# Astrolabe — Codebase Knowledge Graph Skill

## Overview

Astrolabe is a tool for building and querying a knowledge graph of your codebase.
It understands function calls, class hierarchies, imports, and structural
relationships across multiple languages (TypeScript, JavaScript, TSX, Python).

This skill enables AI assistants to:
- Search for symbols, files, and code patterns
- Understand caller/callee relationships
- Detect code impact of proposed changes
- Generate structured dependency reports

## Usage

### Analyze a codebase

\`\`\`bash
npx astrolabe analyze /path/to/repo --output .astrolabe/astrolabe.db
\`\`\`

### Search the knowledge graph

\`\`\`bash
npx astrolabe query "functionName" --db .astrolabe/astrolabe.db
\`\`\`

### Start MCP server (AI assistant integration)

\`\`\`bash
npx astrolabe serve-mcp
\`\`\`

## MCP Tools

When connected via MCP, the following tools are available:

| Tool | Description |
|------|-------------|
| \`astrolabe.list_repos\` | Discover all indexed repositories |
| \`astrolabe.query\` | Hybrid search over the knowledge graph |
| \`astrolabe.context\` | 360-degree symbol view |
| \`astrolabe.impact\` | Blast radius analysis |
| \`astrolabe.detect_changes\` | Git-diff impact mapping |
| \`astrolabe.rename\` | Graph-assisted multi-file rename |
| \`astrolabe.cypher\` | Graph pattern query |

## Supported Languages

${languageList}

## Version

astrolabe v${version}

## Generated

This skill file was auto-generated on ${new Date().toISOString()}.
`;
}

/**
 * Generate the skill Markdown file and write it to disk.
 */
export function generateSkill(outputPath: string): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  const content = skillTemplate(pkg.version);
  writeFileSync(outputPath, content, 'utf-8');
  console.log(`Skill file written to ${outputPath}`);
}
