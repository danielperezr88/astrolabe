/**
 * Pipeline Phase: Route Detection
 *
 * Reads actual source files to detect API route definitions across common
 * web frameworks. Creates Route nodes with HANDLES_ROUTE edges (#137).
 * Also creates FETCHES edges from Function/Method nodes that make HTTP
 * client calls to registered Route nodes (#428).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';

export interface RoutesOutput {
  routeCount: number;
  frameworks: string[];
  fetchesCount: number;
  responseShapeCount: number;
  middlewareCount: number;
}

// ── HTTP client detection patterns ─────────────────────────────────────────

/** Patterns that indicate an HTTP client call in function body text. */
const HTTP_CLIENT_DETECT: RegExp[] = [
  /\bfetch\s*\(/,
  /\baxios\.(get|post|put|delete|patch|request)\s*\(/,
  /\bgot\.(get|post|put|delete|patch)\s*\(/,
  /\b(request|superagent)\s*\(/,
  /\b(httpClient|HttpClient|http\.request)\s*\(/,
];

/** Extracts relative URL strings (e.g. '/api/users') from source text. */
const URL_EXTRACT = /['"`](\/[^'"`\s]*)['"`]/g;

// ── URL ↔ route matching ───────────────────────────────────────────────────

/**
 * Check whether a concrete URL (e.g. `/users/123`) matches a route path
 * pattern (e.g. `/users/:id`).
 *
 * Matching rules:
 * - Exact string equality is a match.
 * - Parameterized segments (`:param`) match any single path segment.
 * - The number of segments must be equal.
 */
export function urlMatchesRoute(url: string, routePath: string): boolean {
  if (url === routePath) return true;
  const urlSegs = url.split('/').filter(Boolean);
  const routeSegs = routePath.split('/').filter(Boolean);
  if (urlSegs.length !== routeSegs.length) return false;
  for (let i = 0; i < routeSegs.length; i++) {
    if (routeSegs[i]!.startsWith(':')) continue;
    if (routeSegs[i] !== urlSegs[i]) return false;
  }
  return true;
}

const FRAMEWORK_PATTERNS: Array<{ name: string; regex: RegExp; extract: (m: RegExpExecArray) => { method: string; path: string } }> = [
  { name: 'express', regex: /\b(app|router)\.(get|post|put|delete|patch|use)\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: m[2], path: m[3] }) },
  { name: 'fastapi', regex: /@\w+\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: m[1], path: m[2] }) },
  // #196: Avoid catastrophic backtracking by keeping regex within decorator parens
  { name: 'flask', regex: /@\w+\.route\s*\(\s*['"]([^'"]+)['"][^)]*?(?:methods\s*=\s*\[([^\]]+)\])?/g, extract: (m) => ({ method: m[2]?.trim() ?? 'GET', path: m[1] }) },
  { name: 'laravel', regex: /\bRoute::(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: m[1], path: m[2] }) },
  { name: 'django', regex: /\bpath\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: 'ANY', path: m[1] }) },
  // #197: Support non-async, arrow functions, and const exports
  { name: 'nextjs', regex: /export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|DELETE|PATCH)\b/g, extract: (m) => ({ method: m[1], path: '[inferred]' }) },
  // Spring Boot - specific HTTP method mappings
  { name: 'spring', regex: /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/g, extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }) },
  // Spring Boot - @RequestMapping (with optional method specification)
  { name: 'spring', regex: /@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?['"]([^'"]+)['"][\s,]*(?:method\s*=\s*RequestMethod\.(GET|POST|PUT|DELETE|PATCH))?/g, extract: (m) => ({ method: m[2] ?? 'ANY', path: m[1] }) },
  // NestJS - method decorators with path (controller prefix combined in post-processing below)
  { name: 'nestjs', regex: /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"]([^'"]+)['"]/g, extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }) },
  // NestJS - method decorators without path argument (e.g. @Get(), @Post())
  { name: 'nestjs', regex: /@(Get|Post|Put|Delete|Patch)\s*\(\s*\)/g, extract: (m) => ({ method: m[1].toUpperCase(), path: '' }) },
  // Django REST Framework - @api_view decorator
  { name: 'django-rest', regex: /@api_view\s*\(\s*\[([^\]]+)\]/g, extract: (m) => ({ method: m[1].replace(/['"]/g, '').trim(), path: '[inferred]' }) },
  // Django REST Framework - @action decorator
  { name: 'django-rest', regex: /@action\s*\([^)]*methods\s*=\s*\[([^\]]+)\]/g, extract: (m) => ({ method: m[1].replace(/['"]/g, '').trim(), path: '[inferred]' }) },
];

// ── NestJS controller prefix detection ─────────────────────────────────────

/** Detects @Controller("prefix") decorator to combine with NestJS method paths. */
const NESTJS_CONTROLLER_PREFIX = /@Controller\s*\(\s*['"]([^'"]+)['"]\)/;

// ── Response shape extraction (#426) ────────────────────────────────────────

/**
 * Extract top-level key names from JSON response shapes in route handler code.
 *
 * Detects patterns like `res.json({...})`, `NextResponse.json({...})`,
 * `jsonify({...})`, `return {...}`, etc. and extracts the top-level field names.
 * Also detects error responses via `.status(4xx/5xx)` chaining.
 */
export function extractResponseKeys(code: string): { responseKeys: string[]; errorKeys: string[] } {
  const responseKeys: string[] = [];
  const errorKeys: string[] = [];

  // ── Pattern 1: .json({...}) — catches res.json, NextResponse.json, chained .status(N).json ──
  const jsonPattern = /\.json\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = jsonPattern.exec(code)) !== null) {
    const afterParen = code.slice(match.index + match[0].length);
    const keys = extractObjectLiteralKeys(afterParen);
    // Look backwards for error status: .status(4xx) or .status(5xx)
    const before = code.slice(Math.max(0, match.index - 80), match.index);
    const isError = /\.status\s*\(\s*(?:4\d\d|5\d\d)\s*\)/.test(before);
    for (const k of keys) {
      if (isError) { if (!errorKeys.includes(k)) errorKeys.push(k); }
      else { if (!responseKeys.includes(k)) responseKeys.push(k); }
    }
  }

  // ── Pattern 2: res.send({...}) ──
  const sendPattern = /\.send\s*\(/g;
  while ((match = sendPattern.exec(code)) !== null) {
    const afterParen = code.slice(match.index + match[0].length);
    const keys = extractObjectLiteralKeys(afterParen);
    const before = code.slice(Math.max(0, match.index - 80), match.index);
    const isError = /\.status\s*\(\s*(?:4\d\d|5\d\d)\s*\)/.test(before);
    for (const k of keys) {
      if (isError) { if (!errorKeys.includes(k)) errorKeys.push(k); }
      else { if (!responseKeys.includes(k)) responseKeys.push(k); }
    }
  }

  // ── Pattern 3: jsonify({...}) — Flask ──
  const jsonifyPattern = /\bjsonify\s*\(/g;
  while ((match = jsonifyPattern.exec(code)) !== null) {
    const afterParen = code.slice(match.index + match[0].length);
    const keys = extractObjectLiteralKeys(afterParen);
    for (const k of keys) {
      if (!responseKeys.includes(k)) responseKeys.push(k);
    }
  }

  // ── Pattern 4: return { ... } — bare object return ──
  const returnPattern = /\breturn\s+\{/g;
  while ((match = returnPattern.exec(code)) !== null) {
    // Include the { that the regex consumed
    const afterBrace = code.slice(match.index + match[0].length);
    const keys = parseObjectLiteralContent(afterBrace);
    for (const k of keys) {
      if (!responseKeys.includes(k)) responseKeys.push(k);
    }
  }

  return { responseKeys, errorKeys };
}

/**
 * Find the first `{...}` in text and extract its top-level keys.
 * Handles nested braces, brackets, parens, and string literals.
 */
function extractObjectLiteralKeys(text: string): string[] {
  // Find the first opening brace
  const braceIdx = text.indexOf('{');
  if (braceIdx < 0) return [];
  return parseObjectLiteralContent(text.slice(braceIdx + 1));
}

/**
 * Parse top-level keys from object literal content (text after the opening `{`).
 * Stops at the matching closing `}`.
 */
function parseObjectLiteralContent(text: string): string[] {
  const keys: string[] = [];
  let depth = 1;
  let i = 0;
  let keyStart = -1;
  let inString: string | null = null;

  while (i < text.length && depth > 0) {
    const ch = text[i];

    // Handle string literals
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; i++; continue; }

    // Track depth
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) break;
      i++;
      continue;
    }
    if (ch === '(' || ch === '[') {
      const close = ch === '(' ? ')' : ']';
      let d = 1;
      i++;
      while (i < text.length && d > 0) {
        if (text[i] === ch) d++;
        if (text[i] === close) d--;
        i++;
      }
      continue;
    }

    // At depth 1, look for key: value pairs
    if (depth === 1 && ch === ':') {
      if (keyStart >= 0) {
        const key = text.slice(keyStart, i).trim();
        if (/^[\w$]+$/.test(key)) keys.push(key);
        keyStart = -1;
      }
      // Skip the value until comma or closing brace at depth 1
      i++;
      let vd = 0;
      let vs: string | null = null;
      while (i < text.length) {
        const vc = text[i];
        if (vs) {
          if (vc === '\\') { i += 2; continue; }
          if (vc === vs) vs = null;
          i++; continue;
        }
        if (vc === '"' || vc === "'" || vc === '`') { vs = vc; i++; continue; }
        if (vc === '{' || vc === '(' || vc === '[') vd++;
        if (vc === '}' || vc === ')' || vc === ']') {
          if (vc === '}' && vd === 0) break;
          vd--;
        }
        if (vc === ',' && vd === 0) break;
        i++;
      }
      continue;
    }

    // Mark potential key start
    if (depth === 1 && keyStart < 0 && /[\w$]/.test(ch)) {
      keyStart = i;
    }
    i++;
  }
  return keys;
}

// ── Middleware extraction (#427) ─────────────────────────────────────────────

/** Common identifiers that are NOT middleware (request/response params). */
const PARAM_IDENTS = new Set(['req', 'res', 'next', 'request', 'response', 'ctx', 'context']);
/** Built-in identifiers that should not be treated as middleware wrappers. */
const BUILTIN_IDENTS = new Set(['require', 'import', 'Promise', 'setTimeout', 'setInterval', 'async', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Map', 'Set', 'JSON', 'Math', 'Date']);

/**
 * Extract middleware names from route definitions and handler wrappers.
 *
 * 1. Express: `app.get(path, mw1, mw2, handler)` — identifier args are middleware
 * 2. Higher-order: `withAuth(handler)`, `withRateLimit(handler)`
 */
export function extractMiddlewareNames(code: string): string[] {
  const middleware: string[] = [];

  // Express: app.get/post/put/delete/patch('path', mw1, mw2, ..., handler)
  // The regex matches up to and including the closing quote of the path string.
  // After that we need the remaining args until the matching closing paren.
  const expressRoutePattern = /\b(?:app|router)\.(?:get|post|put|delete|patch)\s*\(\s*['"][^'"]+['"]/g;
  let match: RegExpExecArray | null;
  while ((match = expressRoutePattern.exec(code)) !== null) {
    const afterPath = code.slice(match.index + match[0].length);
    // We're already inside one level of parens (the opening `(` was in the regex).
    // Scan forward to find the matching closing `)`.
    const argsText = extractRemainingArgs(afterPath);
    const args = splitTopLevelArgs(argsText);
    for (const arg of args) {
      const trimmed = arg.trim();
      if (/^[$\w]+$/.test(trimmed) && !PARAM_IDENTS.has(trimmed)) {
        if (!middleware.includes(trimmed)) middleware.push(trimmed);
      }
    }
  }

  // Higher-order function wrappers: withAuth(handler), withRateLimit(handler)
  const wrapperPattern = /(\w+)\s*\(\s*(?:async\s*)?(?:function\s+\w+|(?:\([^)]*\)|[$\w]+)\s*(?:=>|\{)|[$\w]+Handler|[$\w]+Controller)/g;
  while ((match = wrapperPattern.exec(code)) !== null) {
    const name = match[1];
    if (name && !BUILTIN_IDENTS.has(name) && !PARAM_IDENTS.has(name)) {
      if (!middleware.includes(name)) middleware.push(name);
    }
  }

  return middleware;
}

/**
 * Given text that starts right after the path string in `app.get('path'...`,
 * extract all content until the matching closing `)`.
 * Since the opening `(` was already consumed, we track depth from 0 and
 * return text up to the first unmatched `)`.
 */
function extractRemainingArgs(text: string): string {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (ch === ')' && depth === 0) return text.slice(0, i);
      depth--;
    }
  }
  return text;
}

/** Split comma-separated args respecting nested parens/brackets/braces. */
function splitTopLevelArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      current += ch;
      if (ch === '\\') { if (i + 1 < text.length) current += text[++i]; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current);
  return args;
}

export const routesPhase: PhaseDefinition<RoutesOutput> = {
  name: 'routes',
  dependencies: ['parse-emit'],

  async execute(context: PhaseContext): Promise<RoutesOutput> {
    const { graph } = context;
    let routeCount = 0;
    const frameworks = new Set<string>();

    // #280: Support incremental indexing — only process changed/added files
    const changedPaths = context.state.get('incremental:changedPaths') as Set<string> | undefined;

    for (const node of graph.iterNodes()) {
      if (node.label !== 'File') continue;
      const fp = node.properties.filePath as string | undefined;
      if (!fp) continue;
      if (changedPaths && !changedPaths.has(fp)) continue;

      // Scan related directories and common entry point files (#198)
      if (!/routes?[\/\\]/.test(fp) && !/api[\/\\]/.test(fp) && !/controller/i.test(fp) && !/handler/i.test(fp) && !/route\.(ts|js|py|php)$/i.test(fp) && !/\b(app|main|server|index)\.(ts|js|py|php)$/i.test(fp)) continue;

      try {
        const content = await readFile(join(context.repoPath, fp), 'utf-8');

        // #426: Extract response shapes from file content
        const { responseKeys, errorKeys } = extractResponseKeys(content);
        // #427: Extract middleware names from route definitions
        const middleware = extractMiddlewareNames(content);
        // #427: Check for Next.js middleware.ts/js file
        const hasMiddleware = /\bmiddleware\.(ts|js)\b/.test(fp);
        // NestJS: detect @Controller("prefix") for path combination
        const nestjsPrefixMatch = NESTJS_CONTROLLER_PREFIX.exec(content);
        const nestjsPrefix = nestjsPrefixMatch ? nestjsPrefixMatch[1] : '';

        for (const fw of FRAMEWORK_PATTERNS) {
          let match;
          while ((match = fw.regex.exec(content)) !== null) {
            let { method, path } = fw.extract(match);
            // NestJS: combine @Controller prefix with method decorator path
            if (fw.name === 'nestjs' && nestjsPrefix) {
              const p = nestjsPrefix.startsWith('/') ? nestjsPrefix : '/' + nestjsPrefix;
              path = path === '/' || path === '' ? p
                : path.startsWith('/') ? p + path
                : p + '/' + path;
              path = path.replace(/\/+/g, '/');
            }
            // #297: Include framework name to prevent ID collision across detectors
        const routeId = `route:${fp}:${fw.name}:${method}:${path}`;
            if (graph.getNode(routeId)) continue;

            graph.addNode({
              id: routeId, label: 'Route',
              properties: {
                name: `${method} ${path}`, filePath: fp, method, path, framework: fw.name,
                responseKeys, errorKeys, middleware,
                hasMiddleware: hasMiddleware || undefined,
              },
            });
            graph.addRelationship({
              id: `route:file:${routeId}:${node.id}`, sourceId: node.id, targetId: routeId,
              type: 'HANDLES_ROUTE', confidence: 0.7,
              reason: `Route detected by ${fw.name} pattern in ${fp}`,
            });
            routeCount++;
            frameworks.add(fw.name);
          }
        }
      } catch { /* skip unreadable */ }
    }

    // ── FETCHES edge creation (#428) ──────────────────────────────────────

    // Build a registry: route path → route node IDs
    const routeRegistry = new Map<string, string[]>();
    for (const node of graph.iterNodes()) {
      if (node.label !== 'Route') continue;
      const path = node.properties.path as string | undefined;
      if (!path) continue;
      const ids = routeRegistry.get(path);
      if (ids) ids.push(node.id);
      else routeRegistry.set(path, [node.id]);
    }

    // If no routes were detected, skip FETCHES scanning
    let fetchesCount = 0;
    if (routeRegistry.size > 0) {
      // Collect Function/Method nodes grouped by file for batched file reads
      const functionsByFile = new Map<string, Array<{ id: string; name: string; startLine: number; endLine: number }>>();
      for (const node of graph.iterNodes()) {
        if (node.label !== 'Function' && node.label !== 'Method') continue;
        const fp = node.properties.filePath as string | undefined;
        if (!fp) continue;
        const startLine = (node.properties.startLine as number) ?? 0;
        const endLine = (node.properties.endLine as number) ?? Infinity;
        const name = (node.properties.name as string) ?? '';
        const fns = functionsByFile.get(fp);
        if (fns) fns.push({ id: node.id, name, startLine, endLine });
        else functionsByFile.set(fp, [{ id: node.id, name, startLine, endLine }]);
      }

      for (const [fp, fns] of functionsByFile) {
        let content: string;
        try {
          content = await readFile(join(context.repoPath, fp), 'utf-8');
        } catch { continue; }

        const lines = content.split('\n');

        for (const fn of fns) {
          // Extract the function body from the file (1-indexed lines)
          const start = Math.max(0, fn.startLine - 1);
          const end = fn.endLine === Infinity ? lines.length : Math.min(lines.length, fn.endLine);
          const body = lines.slice(start, end).join('\n');

          // Check if this function contains any HTTP client call
          if (!HTTP_CLIENT_DETECT.some((re) => re.test(body))) continue;

          // Extract all URL strings from the body
          const urls = new Set<string>();
          let urlMatch: RegExpExecArray | null;
          URL_EXTRACT.lastIndex = 0;
          while ((urlMatch = URL_EXTRACT.exec(body)) !== null) {
            urls.add(urlMatch[1]!);
          }

          // Match URLs to registered routes and create FETCHES edges
          for (const url of urls) {
            for (const [routePath, routeIds] of routeRegistry) {
              if (!urlMatchesRoute(url, routePath)) continue;
              for (const routeId of routeIds) {
                const edgeId = `fetches:${fn.id}:${routeId}`;
                if (graph.getRelationship(edgeId)) continue;
                graph.addRelationship({
                  id: edgeId,
                  sourceId: fn.id,
                  targetId: routeId,
                  type: 'FETCHES',
                  confidence: 0.7,
                  reason: `HTTP client call to ${url} matches route ${routePath}`,
                });
                fetchesCount++;
              }
            }
          }
        }
      }
    }

    // ── Aggregate response shape and middleware counts (#426, #427) ──────────
    let responseShapeCount = 0;
    let middlewareCount = 0;
    for (const node of graph.iterNodes()) {
      if (node.label !== 'Route') continue;
      const rk = node.properties.responseKeys as string[] | undefined;
      const ek = node.properties.errorKeys as string[] | undefined;
      const mw = node.properties.middleware as string[] | undefined;
      if ((rk && rk.length > 0) || (ek && ek.length > 0)) responseShapeCount++;
      if (mw && mw.length > 0) middlewareCount++;
    }

    return { routeCount, frameworks: Array.from(frameworks), fetchesCount, responseShapeCount, middlewareCount };
  },
};
