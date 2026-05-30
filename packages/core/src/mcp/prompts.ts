/**
 * MCP Prompt handlers — prompt definitions and message generation.
 *
 * Extracted from server.ts for modularity (#838).
 */

export function getPrompts() {
  return [
    {
      name: 'detect_impact',
      description: 'Pre-commit change analysis workflow — detect changes, gather context, analyze impact, produce a risk report',
      arguments: [
        { name: 'repoPath', description: 'Repository path or name to analyze', required: true },
      ],
    },
    {
      name: 'generate_map',
      description: 'Architecture documentation workflow — query, context, community detection, process tracing, mermaid diagram',
      arguments: [
        { name: 'repoPath', description: 'Repository path or name to document', required: true },
        { name: 'format', description: 'Output format: "mermaid" (default) or "markdown"', required: false },
      ],
    },
    {
      name: 'refactor_safety',
      description: 'Safe refactor workflow — gather context, analyze impact, verify rename safety before refactoring',
      arguments: [
        { name: 'repoPath', description: 'Repository path or name containing the symbol', required: true },
        { name: 'symbol', description: 'Symbol name to refactor', required: true },
      ],
    },
  ];
}

export function getPromptMessages(name: string, args: Record<string, string>) {
  if (name === 'detect_impact') {
    const repo = args.repoPath ?? '';
    const repoArg = repo ? `, repo: "${repo}"` : '';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Perform a pre-commit change impact analysis for the repository${repo ? ` "${repo}"` : ''}. Follow these steps in order:

**Step 1 — Detect Changes**
Call: \`astrolabe.detect_changes({scope: "unstaged"${repoArg}})\`
Identify which files have been modified and which symbols are affected.

**Step 2 — Gather Context**
For each changed symbol returned in Step 1, call: \`astrolabe.context({name: "<symbol>"${repoArg}})\`
Understand what each changed symbol does, who calls it, and what it depends on.

**Step 3 — Analyze Impact**
For each changed symbol, call: \`astrolabe.impact({target: "<symbol>", direction: "upstream"${repoArg}})\`
Determine the blast radius — what else depends on the changed code.

**Step 4 — Produce Risk Report**
Summarize your findings:
- List all changed files and symbols
- Group affected downstream dependencies by risk level (WILL BREAK, LIKELY AFFECTED, MAYBE AFFECTED)
- Flag any cross-community process impacts (higher risk)
- Give a clear GO / NO-GO recommendation for committing`,
        },
      },
    ];
  }

  if (name === 'generate_map') {
    const repo = args.repoPath ?? '';
    const format = args.format ?? 'mermaid';
    const repoLabel = repo ? ` "${repo}"` : '';
    const repoArg = repo ? `, repo: "${repo}"` : '';
    const mermaidStep = format === 'mermaid'
      ? `**Step 5 — Generate Mermaid Diagram**
Call: \`astrolabe.generate_diagram({diagram_type: "community"${repoArg}})\`
This produces a Mermaid graph with communities as subgraphs, member symbols as nodes,
and CALLS/IMPORTS/EXTENDS/IMPLEMENTS relationships as edges.

For process flows, call: \`astrolabe.generate_diagram({diagram_type: "process"${repoArg}})\`
For dependency graphs, call: \`astrolabe.generate_diagram({diagram_type: "dependency"${repoArg}})\`
For class hierarchies, call: \`astrolabe.generate_diagram({diagram_type: "class_hierarchy"${repoArg}})\``
      : `**Step 5 — Generate Markdown Documentation**
Call: \`astrolabe.generate_diagram({diagram_type: "community", format: "markdown"${repoArg}})\`
This produces a Markdown document with architecture overview, per-cluster details, and stats.`;
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Generate architecture documentation for the repository${repoLabel}. Follow these steps in order:

**Step 1 — Discover Repositories**
Call: \`astrolabe.list_repos()\`
Identify the available indexed repositories${repo ? ` and find "${repo}"` : ''}.

**Step 2 — Query Key Symbols**
Call: \`astrolabe.query({query: "main"${repo ? `, repo: "${repo}"` : ''}})\`
Then call: \`astrolabe.query({query: "route"${repo ? `, repo: "${repo}"` : ''}})\`
Find entry points, routes, and top-level architectural elements.

**Step 3 — Read Context and Clusters**
Read resource: \`astrolabe://repo/{name}/context\` for overview stats.
Read resource: \`astrolabe://repo/{name}/clusters\` for functional areas (communities).
Read resource: \`astrolabe://repo/{name}/schema\` for available node/edge types.

**Step 4 — Trace Processes**
Read resource: \`astrolabe://repo/{name}/processes\` for execution flows.
For important processes, read: \`astrolabe://repo/{name}/process/{processName}\` for step-by-step traces.

${mermaidStep}

**Step 6 — Document Each Cluster**
For each cluster found in Step 3, describe:
- Purpose and responsibility
- Key entry points and exported symbols
- Intra-cluster and cross-cluster dependencies`,
        },
      },
    ];
  }

  if (name === 'refactor_safety') {
    const repo = args.repoPath ?? '';
    const symbol = args.symbol ?? '';
    const repoArg = repo ? `, repo: "${repo}"` : '';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Perform a safe refactor analysis for the symbol "${symbol}"${repo ? ` in repository "${repo}"` : ''}. Follow these steps in order:

**Step 1 — Gather Full Context**
Call: \`astrolabe.context({name: "${symbol}"${repoArg}})\`
Understand the symbol's type, file location, incoming dependencies (who depends on it), outgoing dependencies (what it calls), and which processes it participates in.

**Step 2 — Analyze Impact**
Call: \`astrolabe.impact({target: "${symbol}", direction: "upstream"${repoArg}})\`
Determine the blast radius of modifying this symbol — how many callers and dependents will be affected.

Call: \`astrolabe.impact({target: "${symbol}", direction: "downstream"${repoArg}})\`
Determine what this symbol depends on — critical for understanding side effects of changes.

**Step 3 — Verify Rename Safety**
Call: \`astrolabe.rename({symbol_name: "${symbol}", new_name: "<proposed_new_name>", dry_run: true${repoArg}})\`
Preview the rename across all files. Check:
- How many files would be affected
- Whether any references are ambiguous (multiple symbols with same name)
- Whether graph references vs text search references differ in count

**Step 4 — Safety Assessment**
Provide a safety report:
- Total number of upstream dependents (callers that will break)
- Total number of downstream dependencies (things that might change behavior)
- Process membership (is this symbol part of cross-community processes?)
- Rename scope (how many files, any ambiguities)
- Overall safety rating: SAFE / CAUTION / DANGEROUS
- Specific risks and recommendations`,
        },
      },
    ];
  }

  return null;
}