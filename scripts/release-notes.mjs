#!/usr/bin/env node
/**
 * release-notes.mjs — Generate release notes from conventional commits.
 *
 * Usage:
 *   node scripts/release-notes.mjs [from-tag] [to-ref]
 *
 * If from-tag is omitted, uses the latest stable tag (or the repo root).
 * If to-ref is omitted, uses HEAD.
 *
 * Groups commits by type:
 *   feat:     → 🚀 Features
 *   fix:      → 🐛 Bug Fixes
 *   refactor: → 🔧 Refactoring
 *   perf:     → ⚡ Performance
 *   docs:     → 📚 Documentation
 *   test:     → 🧪 Tests
 *   chore:    → 🔨 Chore
 */

import { execFileSync } from 'node:child_process';

// ── Helpers ────────────────────────────────────────────────────────────────

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function getLatestStableTag() {
  const output = git('tag', '-l', 'v*');
  if (!output) return null;
  const tags = output
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));

  if (tags.length === 0) return null;

  // Sort by semver
  return tags.sort((a, b) => {
    const pa = a.slice(1).split('.').map(Number);
    const pb = b.slice(1).split('.').map(Number);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
  }).pop();
}

// ── Main ───────────────────────────────────────────────────────────────────

const fromTag = process.argv[2] || getLatestStableTag();
const toRef = process.argv[3] || 'HEAD';

// Validate inputs: only allow git ref patterns (tags, HEAD, branch names)
const GIT_REF_RE = /^[\w.\-\/]+$/;
if (fromTag && !GIT_REF_RE.test(fromTag)) {
  console.error(`Invalid from-tag: ${fromTag}`);
  process.exit(1);
}
if (toRef && !GIT_REF_RE.test(toRef)) {
  console.error(`Invalid to-ref: ${toRef}`);
  process.exit(1);
}

const range = fromTag ? [`${fromTag}..${toRef}`] : [toRef];
const log = git('log', ...range, '--pretty=format:%H|||%s|||%an', '--no-merges');

if (!log) {
  console.log('No changes since last release.');
  process.exit(0);
}

const TYPE_LABELS = {
  feat: '🚀 Features',
  fix: '🐛 Bug Fixes',
  refactor: '🔧 Refactoring',
  perf: '⚡ Performance',
  docs: '📚 Documentation',
  test: '🧪 Tests',
  chore: '🔨 Chore',
};

const groups = {};
const uncategorized = [];

for (const line of log.split('\n')) {
  if (!line.trim()) continue;
  const [hash, subject, author] = line.split('|||');

  // Parse conventional commit: type(scope): description
  const match = subject.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
  if (!match) {
    uncategorized.push({ hash: hash.slice(0, 7), subject, author });
    continue;
  }

  const [, type, scope, description] = match;
  const label = TYPE_LABELS[type] || null;

  const entry = {
    hash: hash.slice(0, 7),
    description: scope ? `**${scope}**: ${description}` : description,
    author,
    type,
  };

  if (label) {
    if (!groups[label]) groups[label] = [];
    groups[label].push(entry);
  } else {
    uncategorized.push(entry);
  }
}

// ── Output ─────────────────────────────────────────────────────────────────

const sections = [];

for (const [label, entries] of Object.entries(groups)) {
  sections.push(`### ${label}\n`);
  for (const e of entries) {
    sections.push(`- ${e.description} (${e.hash})`);
  }
  sections.push('');
}

if (uncategorized.length > 0) {
  sections.push('### Other Changes\n');
  for (const e of uncategorized) {
    const desc = e.description || e.subject;
    sections.push(`- ${desc} (${e.hash})`);
  }
  sections.push('');
}

// Summary
const totalCommits = Object.values(groups).flat().length + uncategorized.length;
sections.unshift(`## What's Changed\n`);
sections.push(`**Full Changelog**: ${fromTag ? `${fromTag}...${toRef}` : 'Initial release'}`);

console.log(sections.join('\n'));
