/**
 * Tests for the self-contained HTML wiki viewer (#435).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateHtmlViewer } from '../../src/wiki/html-viewer.js';

const TMP_BASE = join(__dirname, '__html_viewer_tmp__');

function makeTempDir(name: string): string {
  const dir = join(TMP_BASE, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(): void {
  if (existsSync(TMP_BASE)) rmSync(TMP_BASE, { recursive: true, force: true });
}

describe('generateHtmlViewer', () => {
  afterEach(() => {
    cleanup();
  });

  it('generates a valid HTML5 document', () => {
    const dir = makeTempDir('html5');
    writeFileSync(join(dir, 'README.md'), '# My Project\n\nWelcome.', 'utf-8');

    const result = generateHtmlViewer(dir, 'My Project');

    expect(result).toBe(join(dir, 'index.html'));
    const html = readFileSync(result, 'utf-8');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toMatch(/<meta\s+name="viewport"/);
    expect(html).toContain('<meta charset="UTF-8">');
    expect(html).toContain('</html>');
  });

  it('includes navigation sidebar with module names', () => {
    const dir = makeTempDir('sidebar');
    writeFileSync(join(dir, 'auth-module.md'), '# Authentication\n\nAuth stuff.', 'utf-8');
    writeFileSync(join(dir, 'db-layer.md'), '# Database\n\nDB stuff.', 'utf-8');

    const html = readFileSync(generateHtmlViewer(dir, 'TestRepo'), 'utf-8');

    // Sidebar should link to both modules
    expect(html).toMatch(/class="sidebar"/);
    expect(html).toMatch(/href="#auth-module"/);
    expect(html).toMatch(/href="#db-layer"/);
    expect(html).toContain('Authentication');
    expect(html).toContain('Database');
    expect(html).toContain('TestRepo');
  });

  it('converts markdown headings to HTML elements', () => {
    const dir = makeTempDir('headings');
    const md = [
      '# Title One',
      '## Heading Two',
      '### Heading Three',
      '#### Heading Four',
      'Some text',
    ].join('\n');
    writeFileSync(join(dir, 'page.md'), md, 'utf-8');

    const html = readFileSync(generateHtmlViewer(dir, 'Repo'), 'utf-8');

    expect(html).toContain('<h1>Title One</h1>');
    expect(html).toContain('<h2>Heading Two</h2>');
    expect(html).toContain('<h3>Heading Three</h3>');
    expect(html).toContain('<h4>Heading Four</h4>');
  });

  it('converts inline code and bold text', () => {
    const dir = makeTempDir('inline');
    const md = [
      '# Module',
      'The **important** function uses `processData` to work.',
      '- item with `code` and **bold**',
    ].join('\n');
    writeFileSync(join(dir, 'mod.md'), md, 'utf-8');

    const html = readFileSync(generateHtmlViewer(dir, 'Repo'), 'utf-8');

    expect(html).toContain('<strong>important</strong>');
    expect(html).toContain('<code>processData</code>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('embeds all module content as sections', () => {
    const dir = makeTempDir('sections');
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n\nAlpha content here.', 'utf-8');
    writeFileSync(join(dir, 'beta.md'), '# Beta\n\nBeta content here.', 'utf-8');
    writeFileSync(join(dir, 'README.md'), '# Overview\n\nProject overview.', 'utf-8');

    const html = readFileSync(generateHtmlViewer(dir, 'Repo'), 'utf-8');

    // Each .md file becomes a page-section with an id
    expect(html).toMatch(/id="alpha"/);
    expect(html).toMatch(/id="beta"/);
    expect(html).toMatch(/id="README"/);
    expect(html).toContain('Alpha content here');
    expect(html).toContain('Beta content here');
    expect(html).toContain('Project overview');
  });

  it('handles empty wiki directory gracefully', () => {
    const dir = makeTempDir('empty');
    // No .md files — only index.html should be produced

    const html = readFileSync(generateHtmlViewer(dir, 'EmptyRepo'), 'utf-8');

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('EmptyRepo');
    // No nav links or sections
    expect(html).not.toContain('class="page-section"');
  });

  it('converts links and list items', () => {
    const dir = makeTempDir('links');
    const md = [
      '# Links Module',
      '- [Auth](auth.md) handles login',
      '- [DB](db.md) handles storage',
      'See the [docs](https://example.com) for more.',
    ].join('\n');
    writeFileSync(join(dir, 'links.md'), md, 'utf-8');

    const html = readFileSync(generateHtmlViewer(dir, 'Repo'), 'utf-8');

    expect(html).toContain('<a href="auth.md">Auth</a>');
    expect(html).toContain('<a href="db.md">DB</a>');
    expect(html).toContain('<a href="https://example.com">docs</a>');
    expect(html).toContain('<li>');
    expect(html).toContain('<ul>');
  });
});
