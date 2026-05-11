/**
 * Test Coverage Report Parser (#463).
 *
 * Parses LCOV, Cobertura (XML), and Istanbul/NYC (JSON) coverage formats
 * into a unified CoverageReport structure.
 *
 * No external dependencies — regex-based XML parsing for Cobertura.
 */

// #463: Unified coverage data types

export interface FileCoverage {
  filePath: string;
  lines: { line: number; hitCount: number }[];
  functions: { name: string; line: number; hitCount: number }[];
  lineCoverage: number;    // 0-100 percentage
  functionCoverage: number; // 0-100 percentage
}

export interface CoverageReport {
  files: FileCoverage[];
  totalLines: number;
  coveredLines: number;
  lineCoveragePercent: number;
  totalFunctions: number;
  coveredFunctions: number;
  functionCoveragePercent: number;
}

// ── Auto-detect format ─────────────────────────────────────────────────────

/**
 * #463: Detect coverage report format from content.
 * Returns 'lcov' for LCOV, 'istanbul' for Istanbul/NYC JSON, 'cobertura' for
 * Cobertura XML, or null if the format cannot be determined.
 */
export function detectFormat(content: string): 'lcov' | 'istanbul' | 'cobertura' | null {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('TN:') || trimmed.startsWith('SF:')) return 'lcov';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'istanbul';
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<coverage')) return 'cobertura';
  return null;
}

// ── LCOV parser ────────────────────────────────────────────────────────────

/**
 * #463: Parse LCOV coverage report.
 * Handles: SF: (source file), DA:line,hits (line data), FN:line,name (function),
 * FNDA:hits,name (function data), LF:/LH: (line summary), FNF:/FNH: (function summary),
 * end_of_record (end of file record).
 */
export function parseLcov(content: string): CoverageReport {
  const files: FileCoverage[] = [];
  let currentFile: Partial<FileCoverage> & { lineData: Map<number, number>; fnData: Map<string, { line: number; hits: number }> } | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    // SF: — source file path
    if (line.startsWith('SF:')) {
      currentFile = {
        filePath: line.substring(3),
        lines: [],
        functions: [],
        lineData: new Map(),
        fnData: new Map(),
      };
      continue;
    }

    // DA:line,hits — line data
    if (line.startsWith('DA:') && currentFile) {
      const parts = line.substring(3).split(',');
      const lineNum = parseInt(parts[0], 10);
      const hits = parseInt(parts[1], 10);
      if (!isNaN(lineNum) && !isNaN(hits)) {
        currentFile.lineData.set(lineNum, hits);
      }
      continue;
    }

    // FN:line,name — function definition
    if (line.startsWith('FN:') && currentFile) {
      const parts = line.substring(3).split(',');
      const fnLine = parseInt(parts[0], 10);
      const fnName = parts.slice(1).join(','); // handle names with commas
      if (!isNaN(fnLine) && fnName) {
        currentFile.fnData.set(fnName, { line: fnLine, hits: 0 });
      }
      continue;
    }

    // FNDA:hits,name — function hit data
    if (line.startsWith('FNDA:') && currentFile) {
      const parts = line.substring(5).split(',');
      const hits = parseInt(parts[0], 10);
      const fnName = parts.slice(1).join(',');
      if (!isNaN(hits) && fnName) {
        const existing = currentFile.fnData.get(fnName);
        if (existing) {
          existing.hits = hits;
        }
      }
      continue;
    }

    // end_of_record — finalize current file
    if (line === 'end_of_record' && currentFile) {
      const lineEntries = [...currentFile.lineData.entries()]
        .map(([l, h]) => ({ line: l, hitCount: h }))
        .sort((a, b) => a.line - b.line);

      const funcEntries = [...currentFile.fnData.entries()]
        .map(([name, data]) => ({ name, line: data.line, hitCount: data.hits }));

      const totalLines = lineEntries.length;
      const coveredLines = lineEntries.filter((e) => e.hitCount > 0).length;
      const totalFns = funcEntries.length;
      const coveredFns = funcEntries.filter((f) => f.hitCount > 0).length;

      files.push({
        filePath: currentFile.filePath ?? '',
        lines: lineEntries,
        functions: funcEntries,
        lineCoverage: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
        functionCoverage: totalFns > 0 ? (coveredFns / totalFns) * 100 : 0,
      });
      currentFile = null;
    }
  }

  // Handle case where file doesn't end with end_of_record
  if (currentFile) {
    const lineEntries = [...currentFile.lineData.entries()]
      .map(([l, h]) => ({ line: l, hitCount: h }))
      .sort((a, b) => a.line - b.line);

    const funcEntries = [...currentFile.fnData.entries()]
      .map(([name, data]) => ({ name, line: data.line, hitCount: data.hits }));

    const totalLines = lineEntries.length;
    const coveredLines = lineEntries.filter((e) => e.hitCount > 0).length;
    const totalFns = funcEntries.length;
    const coveredFns = funcEntries.filter((f) => f.hitCount > 0).length;

    files.push({
      filePath: currentFile.filePath ?? '',
      lines: lineEntries,
      functions: funcEntries,
      lineCoverage: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
      functionCoverage: totalFns > 0 ? (coveredFns / totalFns) * 100 : 0,
    });
  }

  return buildReport(files);
}

// ── Istanbul/NYC parser ────────────────────────────────────────────────────

/**
 * #463: Parse Istanbul/NYC JSON coverage report.
 * Format: { "filePath": { "s": {"1": 0}, "statementMap": {...}, "fnMap": {...}, "f": {...} } }
 */
export function parseIstanbul(content: string): CoverageReport {
  const files: FileCoverage[] = [];

  let data: Record<string, any>;
  try {
    data = JSON.parse(content);
  } catch {
    return buildReport([]);
  }

  // Istanbul can be a top-level object keyed by file path, or wrapped in a single key
  // Handle both { "path": {...} } and { "": { "path": {...} } } formats
  let entries: [string, any][] = Object.entries(data);
  if (entries.length === 1 && typeof entries[0][1] === 'object' && !entries[0][1].s) {
    // Possibly wrapped — try one level deeper
    const inner = entries[0][1];
    if (inner && typeof inner === 'object') {
      entries = Object.entries(inner);
    }
  }

  for (const [filePath, fileData] of entries) {
    if (!fileData || typeof fileData !== 'object') continue;
    if (!fileData.s && !fileData.f && !fileData.statementMap) continue;

    // Map statements to lines
    const lineData = new Map<number, number>();
    const statementMap = fileData.statementMap ?? {};
    const statements = fileData.s ?? {};

    for (const [idx, count] of Object.entries(statements)) {
      const stmt = statementMap[idx];
      if (!stmt || !stmt.start) continue;
      const lineNum = stmt.start.line as number;
      const hits = typeof count === 'number' ? count : 0;
      // Keep the highest hit count if multiple statements map to the same line
      const existing = lineData.get(lineNum) ?? 0;
      lineData.set(lineNum, Math.max(existing, hits));
    }

    // Extract function coverage
    const fnMap = fileData.fnMap ?? {};
    const fnHits = fileData.f ?? {};
    const functions: { name: string; line: number; hitCount: number }[] = [];

    for (const [idx, fnDef] of Object.entries(fnMap)) {
      const fd = fnDef as any;
      if (!fd || !fd.loc || !fd.loc.start) continue;
      const name = (fd.name as string) ?? `anonymous_${idx}`;
      const line = fd.loc.start.line as number;
      const hits = typeof fnHits[idx] === 'number' ? fnHits[idx] as number : 0;
      functions.push({ name, line, hitCount: hits });
    }

    const lineEntries = [...lineData.entries()]
      .map(([l, h]) => ({ line: l, hitCount: h }))
      .sort((a, b) => a.line - b.line);

    const totalLines = lineEntries.length;
    const coveredLines = lineEntries.filter((e) => e.hitCount > 0).length;
    const totalFns = functions.length;
    const coveredFns = functions.filter((f) => f.hitCount > 0).length;

    files.push({
      filePath,
      lines: lineEntries,
      functions,
      lineCoverage: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
      functionCoverage: totalFns > 0 ? (coveredFns / totalFns) * 100 : 0,
    });
  }

  return buildReport(files);
}

// ── Cobertura XML parser ───────────────────────────────────────────────────

/**
 * #463: Parse Cobertura XML coverage report.
 * Regex-based parsing — no external dependencies.
 * Handles: <coverage>, <packages>, <class>, <lines>, <methods>, <line>,
 * <methods>/<method>/<lines>.
 */
export function parseCobertura(content: string): CoverageReport {
  const files: FileCoverage[] = [];

  // Extract <class> blocks with filename attribute
  const classRe = /<class\s+[^>]*filename="([^"]*)"[^>]*>([\s\S]*?)<\/class>/g;
  let classMatch: RegExpExecArray | null;

  while ((classMatch = classRe.exec(content)) !== null) {
    const filePath = classMatch[1];
    const classBody = classMatch[2];

    // Extract line coverage from <lines> directly under <class>
    const lineData = new Map<number, number>();
    const linesRe = /<line\s+[^>]*number="(\d+)"[^>]*hits="(\d+)"[^>]*\/?>/g;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = linesRe.exec(classBody)) !== null) {
      const lineNum = parseInt(lineMatch[1], 10);
      const hits = parseInt(lineMatch[2], 10);
      if (!isNaN(lineNum) && !isNaN(hits)) {
        lineData.set(lineNum, hits);
      }
    }

    // Extract method/function coverage
    const functions: { name: string; line: number; hitCount: number }[] = [];
    const methodRe = /<method\s+[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/method>/g;
    let methodMatch: RegExpExecArray | null;
    while ((methodMatch = methodRe.exec(classBody)) !== null) {
      const methodName = methodMatch[1];
      const methodBody = methodMatch[2];

      // Get method line number from nested <line> tags
      let methodLine = 0;
      let methodHits = 0;
      const methodLineRe = /<line\s+[^>]*number="(\d+)"[^>]*hits="(\d+)"[^>]*\/?>/g;
      let mlMatch: RegExpExecArray | null;
      while ((mlMatch = methodLineRe.exec(methodBody)) !== null) {
        const ln = parseInt(mlMatch[1], 10);
        const h = parseInt(mlMatch[2], 10);
        if (methodLine === 0) methodLine = ln;
        methodHits += h;
      }

      functions.push({ name: methodName, line: methodLine, hitCount: methodHits > 0 ? 1 : 0 });
    }

    const lineEntries = [...lineData.entries()]
      .map(([l, h]) => ({ line: l, hitCount: h }))
      .sort((a, b) => a.line - b.line);

    const totalLines = lineEntries.length;
    const coveredLines = lineEntries.filter((e) => e.hitCount > 0).length;
    const totalFns = functions.length;
    const coveredFns = functions.filter((f) => f.hitCount > 0).length;

    files.push({
      filePath,
      lines: lineEntries,
      functions,
      lineCoverage: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
      functionCoverage: totalFns > 0 ? (coveredFns / totalFns) * 100 : 0,
    });
  }

  return buildReport(files);
}

// ── Dispatch parser ────────────────────────────────────────────────────────

/**
 * #463: Parse a coverage report with an explicit or auto-detected format.
 */
export function parseCoverageReport(content: string, format: 'lcov' | 'istanbul' | 'cobertura'): CoverageReport {
  switch (format) {
    case 'lcov':
      return parseLcov(content);
    case 'istanbul':
      return parseIstanbul(content);
    case 'cobertura':
      return parseCobertura(content);
    default:
      return buildReport([]);
  }
}

// ── Path matching utility ──────────────────────────────────────────────────

/**
 * #463: Normalize a file path for matching (handles absolute vs relative,
 * forward vs backslash). Returns a lower-cased, forward-slash path with
 * leading ./ stripped.
 */
export function normalizeCoveragePath(fp: string): string {
  let normalized = fp.replace(/\\/g, '/');
  // Strip leading ./ or .\
  while (normalized.startsWith('./')) normalized = normalized.substring(2);
  // Strip leading /
  while (normalized.startsWith('/')) normalized = normalized.substring(1);
  return normalized.toLowerCase();
}

/**
 * #463: Check if two file paths refer to the same file, accounting for
 * absolute vs relative paths and different separators.
 */
export function coveragePathMatches(coveragePath: string, graphPath: string): boolean {
  const cp = normalizeCoveragePath(coveragePath);
  const gp = normalizeCoveragePath(graphPath);

  if (cp === gp) return true;
  // Check if one ends with the other
  if (cp.endsWith(gp) || gp.endsWith(cp)) return true;

  return false;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function buildReport(files: FileCoverage[]): CoverageReport {
  const totalLines = files.reduce((sum, f) => sum + f.lines.length, 0);
  const coveredLines = files.reduce((sum, f) => sum + f.lines.filter((l) => l.hitCount > 0).length, 0);
  const totalFunctions = files.reduce((sum, f) => sum + f.functions.length, 0);
  const coveredFunctions = files.reduce((sum, f) => sum + f.functions.filter((fn) => fn.hitCount > 0).length, 0);

  return {
    files,
    totalLines,
    coveredLines,
    lineCoveragePercent: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
    totalFunctions,
    coveredFunctions,
    functionCoveragePercent: totalFunctions > 0 ? (coveredFunctions / totalFunctions) * 100 : 0,
  };
}
