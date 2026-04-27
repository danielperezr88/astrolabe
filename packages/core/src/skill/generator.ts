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

function skillTemplate(version: string): string {
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
| \`astrolabe.search\` | Search the knowledge graph for symbols |
| \`astrolabe.relationships\` | Get relationships for a symbol |
| \`astrolabe.analyze\` | Analyze a repo and build the graph |

## Supported Languages

- TypeScript (.ts, .tsx, .mts, .cts)
- JavaScript (.js, .jsx, .mjs, .cjs)
- Python (.py, .pyw)

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
