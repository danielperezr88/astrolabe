/**
 * Self-contained HTML Wiki Viewer (#435)
 *
 * Generates a single index.html from wiki markdown files.
 * All CSS and content is embedded inline — no external dependencies.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Convert basic markdown to HTML (regex-based, no external deps). */
function markdownToHtml(md: string): string {
  let html = md;

  // Escape HTML entities first (but preserve what we'll generate)
  html = html.replace(/&/g, '&amp;');
  html = html.replace(/</g, '&lt;');
  html = html.replace(/>/g, '&gt;');

  // Blockquote lines (> text)
  html = html.replace(/^&gt;\s*(.+)$/gm, '<blockquote>$1</blockquote>');

  // Headings (must come before paragraph handling)
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Unordered list items
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>\n$1</ul>');

  // Paragraphs: wrap non-tag lines
  html = html
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (
        trimmed === '' ||
        trimmed.startsWith('<h') ||
        trimmed.startsWith('<ul') ||
        trimmed.startsWith('</ul') ||
        trimmed.startsWith('<li') ||
        trimmed.startsWith('<hr') ||
        trimmed.startsWith('<blockquote')
      ) {
        return line;
      }
      return `<p>${line}</p>`;
    })
    .join('\n');

  return html;
}

interface WikiPage {
  filename: string;
  title: string;
  htmlContent: string;
}

/** Parse module title from the first `# heading` in markdown content. */
function extractTitle(md: string, fallback: string): string {
  const match = md.match(/^#\s+(.+)$/m);
  return match ? match[1] : fallback;
}

/** Generate the inline CSS for the HTML viewer. */
function buildCss(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.6; color: #1a1a2e; background: #f5f5f7; }
    .container { display: flex; min-height: 100vh; }
    .sidebar { width: 260px; background: #16213e; color: #e0e0e0; padding: 20px 0; position: fixed; top: 0; left: 0; bottom: 0; overflow-y: auto; }
    .sidebar h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #8899aa; padding: 0 20px 12px; border-bottom: 1px solid #2a3a5e; margin-bottom: 8px; }
    .sidebar a { display: block; padding: 8px 20px; color: #c8d6e5; text-decoration: none; font-size: 14px; transition: background 0.15s; }
    .sidebar a:hover { background: #1a2744; color: #ffffff; }
    .main { margin-left: 260px; flex: 1; padding: 32px 40px; max-width: 900px; }
    h1 { font-size: 28px; margin: 32px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #e0e0e0; color: #0f3460; }
    h1:first-child { margin-top: 0; }
    h2 { font-size: 22px; margin: 28px 0 10px; color: #1a1a2e; }
    h3 { font-size: 18px; margin: 20px 0 8px; color: #333; }
    h4, h5 { margin: 16px 0 6px; color: #444; }
    p { margin: 8px 0; }
    code { background: #eef1f5; padding: 2px 6px; border-radius: 3px; font-size: 13px; font-family: "SF Mono", "Fira Code", "Consolas", monospace; }
    blockquote { border-left: 4px solid #0f3460; margin: 12px 0; padding: 8px 16px; background: #eef1f5; color: #555; }
    ul { margin: 8px 0 8px 24px; }
    li { margin: 4px 0; }
    a { color: #0f3460; text-decoration: underline; }
    hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
    .page-section { margin-bottom: 48px; }
    @media (max-width: 768px) {
      .sidebar { position: relative; width: 100%; bottom: auto; }
      .main { margin-left: 0; padding: 20px; }
      .container { flex-direction: column; }
    }
  `;
}

/**
 * Generate a self-contained HTML viewer from wiki markdown files.
 *
 * Reads all `.md` files from `wikiDir`, converts them to HTML,
 * and writes a single `index.html` with inline CSS and navigation.
 *
 * @returns The path to the generated `index.html`.
 */
export function generateHtmlViewer(wikiDir: string, repoName: string): string {
  const files = readdirSync(wikiDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const pages: WikiPage[] = files.map((filename) => {
    const content = readFileSync(join(wikiDir, filename), 'utf-8');
    const title = extractTitle(content, filename.replace(/\.md$/, ''));
    const htmlContent = markdownToHtml(content);
    return { filename, title, htmlContent };
  });

  const navLinks = pages
    .map((p) => {
      const id = p.filename.replace(/\.md$/, '');
      return `<a href="#${id}">${escapeHtml(p.title)}</a>`;
    })
    .join('\n');

  const sections = pages
    .map((p) => {
      const id = p.filename.replace(/\.md$/, '');
      return `<div class="page-section" id="${id}">\n${p.htmlContent}\n</div>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(repoName)} — Wiki</title>
  <style>${buildCss()}</style>
</head>
<body>
  <div class="container">
    <nav class="sidebar">
      <h2>${escapeHtml(repoName)}</h2>
${navLinks}
    </nav>
    <main class="main">
${sections}
    </main>
  </div>
</body>
</html>`;

  const outputPath = join(wikiDir, 'index.html');
  writeFileSync(outputPath, html, 'utf-8');
  return outputPath;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
