/**
 * Tests for ServiceBoundaryDetector.
 *
 * Uses temp directories with real file structures to test detection logic.
 * Key insight: source files must exist at the same level as manifest files
 * to contribute the +0.2 confidence boost. Files in subdirs (src/) only
 * contribute +0.1 via the src/lib subdirectory check.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { ServiceBoundaryDetector, autoDetectGroups } = await vi.importActual<
  typeof import('../../src/analysis/service-boundary-detector.js')
>('../../src/analysis/service-boundary-detector.js');

// ── Test fixture helpers ───────────────────────────────────────────────────

let testDir: string;

function setupTempDir(name: string): string {
  const dir = join(tmpdir(), `sbd-test-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

function createFile(base: string, relativePath: string, content = ''): void {
  const fullPath = join(base, relativePath);
  // Extract parent directory from path
  const sep = fullPath.includes('\\') ? '\\' : '/';
  const parts = fullPath.split(sep);
  const dir = parts.slice(0, -1).join(sep);
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ServiceBoundaryDetector', () => {
  beforeEach(() => {
    testDir = setupTempDir('main');
  });

  afterEach(() => {
    cleanup(testDir);
  });

  // 1. Single Node.js service
  it('detects a single Node.js service with package.json and source files', async () => {
    createFile(testDir, 'package.json', JSON.stringify({ name: 'my-app' }));
    createFile(testDir, 'index.ts', 'export {}'); // source at root for +0.2 boost

    const detector = new ServiceBoundaryDetector({ repoPath: testDir });
    const results = await detector.detect();

    expect(results.length).toBeGreaterThanOrEqual(1);
    const root = results.find((r) => r.servicePath === testDir);
    expect(root).toBeDefined();
    expect(root!.markers).toContain('package.json');
    expect(root!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(root!.languages).toContain('javascript');
    expect(root!.serviceName).toBe('my-app');
  });

  // 2. Monorepo with multiple services
  it('detects multiple services in a monorepo', async () => {
    // Root package.json for the monorepo
    createFile(testDir, 'package.json', JSON.stringify({ name: 'monorepo-root' }));
    createFile(testDir, 'index.ts', 'export {}');
    // Service A — source file at service root for confidence
    createFile(testDir, 'packages/service-a/package.json', JSON.stringify({ name: '@org/service-a' }));
    createFile(testDir, 'packages/service-a/index.ts', 'export {}');
    // Service B
    createFile(testDir, 'packages/service-b/package.json', JSON.stringify({ name: '@org/service-b' }));
    createFile(testDir, 'packages/service-b/index.ts', 'export {}');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir });
    const results = await detector.detect();

    expect(results.length).toBeGreaterThanOrEqual(3);
    const names = results.map((r) => r.serviceName);
    expect(names).toContain('service-a');
    expect(names).toContain('service-b');
  });

  // 3. Nested services — child is detected separately from parent
  it('detects nested services independently from parent', async () => {
    createFile(testDir, 'package.json', JSON.stringify({ name: 'parent' }));
    createFile(testDir, 'index.ts', 'export {}');
    createFile(testDir, 'services/api/package.json', JSON.stringify({ name: 'api-svc' }));
    createFile(testDir, 'services/api/index.ts', 'export {}');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir });
    const results = await detector.detect();

    const apiResult = results.find((r) => r.serviceName === 'api-svc');
    expect(apiResult).toBeDefined();
    expect(apiResult!.servicePath).toContain(join('services', 'api'));
  });

  // 4. Skip directories
  it('skips node_modules, .git, dist, build, vendor, __pycache__', async () => {
    createFile(testDir, 'package.json', JSON.stringify({ name: 'main' }));
    createFile(testDir, 'index.ts', 'export {}');
    // These should be skipped
    createFile(testDir, 'node_modules/pkg/package.json', JSON.stringify({ name: 'skipped-node-modules' }));
    createFile(testDir, '.git/config', 'gitconfig');
    createFile(testDir, 'dist/package.json', JSON.stringify({ name: 'skipped-dist' }));
    createFile(testDir, 'build/package.json', JSON.stringify({ name: 'skipped-build' }));
    createFile(testDir, 'vendor/pkg/package.json', JSON.stringify({ name: 'skipped-vendor' }));
    createFile(testDir, '__pycache__/pkg/pyproject.toml', '[project]');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir });
    const results = await detector.detect();

    const skippedPaths = results.map((r) => r.servicePath);
    expect(skippedPaths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(skippedPaths.some((p) => p.includes('.git'))).toBe(false);
    expect(skippedPaths.some((p) => p.includes('dist'))).toBe(false);
    expect(skippedPaths.some((p) => p.includes('build'))).toBe(false);
    expect(skippedPaths.some((p) => p.includes('vendor'))).toBe(false);
    expect(skippedPaths.some((p) => p.includes('__pycache__'))).toBe(false);
  });

  // 5. Confidence scoring — manifest only vs manifest + source
  it('gives higher confidence when source files are present', async () => {
    // Manifest-only dir
    const dirA = join(testDir, 'manifest-only');
    mkdirSync(dirA, { recursive: true });
    writeFileSync(join(dirA, 'package.json'), '{}', 'utf-8');

    // Manifest + source dir
    const dirB = join(testDir, 'manifest-and-source');
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, 'package.json'), '{}', 'utf-8');
    writeFileSync(join(dirB, 'index.ts'), 'export {}');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir, minConfidence: 0 });
    const results = await detector.detect();

    const a = results.find((r) => r.servicePath === dirA);
    const b = results.find((r) => r.servicePath === dirB);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(b!.confidence).toBeGreaterThan(a!.confidence);
  });

  // 6. Confidence scoring — src/ or lib/ subdirectory adds +0.1
  it('boosts confidence when src/ or lib/ subdirectory exists', async () => {
    const dirNoSrc = join(testDir, 'no-src');
    mkdirSync(dirNoSrc, { recursive: true });
    writeFileSync(join(dirNoSrc, 'package.json'), '{}', 'utf-8');
    writeFileSync(join(dirNoSrc, 'index.ts'), 'export {}');

    const dirWithSrc = join(testDir, 'with-src');
    mkdirSync(dirWithSrc, { recursive: true });
    writeFileSync(join(dirWithSrc, 'package.json'), '{}', 'utf-8');
    writeFileSync(join(dirWithSrc, 'index.ts'), 'export {}');
    mkdirSync(join(dirWithSrc, 'src'), { recursive: true });

    const detector = new ServiceBoundaryDetector({ repoPath: testDir, minConfidence: 0 });
    const results = await detector.detect();

    const noSrc = results.find((r) => r.servicePath === dirNoSrc);
    const withSrc = results.find((r) => r.servicePath === dirWithSrc);

    expect(noSrc).toBeDefined();
    expect(withSrc).toBeDefined();
    // Both have marker + source = 0.5; withSrc also has src/ dir = +0.1
    expect(withSrc!.confidence).toBeGreaterThan(noSrc!.confidence);
  });

  // 7. Language detection — Go service
  it('detects Go service from go.mod and .go files', async () => {
    createFile(testDir, 'go.mod', 'module github.com/org/my-go-svc\n\ngo 1.21');
    createFile(testDir, 'main.go', 'package main');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir });
    const results = await detector.detect();

    const svc = results.find((r) => r.servicePath === testDir);
    expect(svc).toBeDefined();
    expect(svc!.markers).toContain('go.mod');
    expect(svc!.languages).toContain('go');
  });

  // 8. Language detection — Python service
  it('detects Python service from pyproject.toml', async () => {
    createFile(testDir, 'pyproject.toml', '[project]\nname = "my-py-svc"');
    createFile(testDir, 'app.py', 'print("hello")');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir });
    const results = await detector.detect();

    const svc = results.find((r) => r.servicePath === testDir);
    expect(svc).toBeDefined();
    expect(svc!.markers).toContain('pyproject.toml');
    expect(svc!.languages).toContain('python');
  });

  // 9. Language detection — Rust service
  it('detects Rust service from Cargo.toml', async () => {
    createFile(testDir, 'Cargo.toml', '[package]\nname = "my-rust-svc"\nversion = "0.1.0"');
    createFile(testDir, 'main.rs', 'fn main() {}');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir });
    const results = await detector.detect();

    const svc = results.find((r) => r.servicePath === testDir);
    expect(svc).toBeDefined();
    expect(svc!.markers).toContain('Cargo.toml');
    expect(svc!.languages).toContain('rust');
  });

  // 10. Name derivation — scoped package.json name
  it('strips scope from package.json name (@org/pkg → pkg)', async () => {
    createFile(testDir, 'package.json', JSON.stringify({ name: '@my-org/my-service' }));
    createFile(testDir, 'index.ts', 'export {}');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir });
    const results = await detector.detect();

    const svc = results.find((r) => r.servicePath === testDir);
    expect(svc).toBeDefined();
    expect(svc!.serviceName).toBe('my-service');
  });

  // 11. Name derivation — fallback to directory name
  it('falls back to directory name when manifest has no name', async () => {
    const svcDir = join(testDir, 'my-custom-dir');
    mkdirSync(svcDir, { recursive: true });
    writeFileSync(join(svcDir, 'requirements.txt'), 'flask', 'utf-8');
    writeFileSync(join(svcDir, 'app.py'), 'print("hello")', 'utf-8');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir });
    const results = await detector.detect();

    const svc = results.find((r) => r.servicePath === svcDir);
    expect(svc).toBeDefined();
    expect(svc!.serviceName).toBe('my-custom-dir');
  });

  // 12. minConfidence filtering
  it('filters results below minConfidence', async () => {
    // Manifest-only: confidence = 0.3 (below 0.5 default)
    createFile(testDir, 'package.json', '{}');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir, minConfidence: 0.5 });
    const results = await detector.detect();

    // Without source files, confidence is just 0.3, so should be filtered out
    expect(results.find((r) => r.servicePath === testDir)).toBeUndefined();
  });

  // 13. maxDepth limits traversal
  it('respects maxDepth to limit traversal depth', async () => {
    createFile(testDir, 'package.json', JSON.stringify({ name: 'root' }));
    createFile(testDir, 'index.ts', 'export {}');
    createFile(testDir, 'a/b/c/deep/package.json', JSON.stringify({ name: 'deep-svc' }));
    createFile(testDir, 'a/b/c/deep/index.ts', 'export {}');

    // maxDepth=2 should not reach depth 4
    const shallow = new ServiceBoundaryDetector({ repoPath: testDir, maxDepth: 2 });
    const results = await shallow.detect();

    expect(results.find((r) => r.serviceName === 'deep-svc')).toBeUndefined();
  });

  // 14. C# project detection via .csproj suffix
  it('detects C# project from .csproj file suffix', async () => {
    createFile(testDir, 'MyProject.csproj', '<Project></Project>');
    createFile(testDir, 'Program.cs', 'Console.WriteLine("hi");');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir, minConfidence: 0 });
    const results = await detector.detect();

    const svc = results.find((r) => r.servicePath === testDir);
    expect(svc).toBeDefined();
    expect(svc!.markers.some((m) => m.endsWith('.csproj'))).toBe(true);
    expect(svc!.languages).toContain('csharp');
  });

  // 15. Multiple manifest markers in one directory
  it('handles multiple manifest markers in one directory', async () => {
    createFile(testDir, 'package.json', JSON.stringify({ name: 'fullstack' }));
    createFile(testDir, 'requirements.txt', 'flask');
    createFile(testDir, 'index.ts', 'export {}');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir, minConfidence: 0 });
    const results = await detector.detect();

    const svc = results.find((r) => r.servicePath === testDir);
    expect(svc).toBeDefined();
    expect(svc!.markers).toContain('package.json');
    expect(svc!.markers).toContain('requirements.txt');
    expect(svc!.languages).toContain('javascript');
    expect(svc!.languages).toContain('python');
  });

  // 16. autoDetectGroups convenience function
  it('autoDetectGroups convenience function works', async () => {
    createFile(testDir, 'package.json', JSON.stringify({ name: 'convenience-test' }));
    createFile(testDir, 'index.ts', 'export {}');

    const results = await autoDetectGroups(testDir);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.serviceName === 'convenience-test')).toBe(true);
  });

  // 17. Empty directory returns no results
  it('returns empty for directory with no markers', async () => {
    mkdirSync(join(testDir, 'empty-subdir'), { recursive: true });

    const detector = new ServiceBoundaryDetector({ repoPath: testDir });
    const results = await detector.detect();

    expect(results).toEqual([]);
  });

  // 18. Name derivation — go.mod module path
  it('derives name from go.mod module path', async () => {
    createFile(testDir, 'go.mod', 'module github.com/my-org/billing-service\n\ngo 1.21');
    createFile(testDir, 'main.go', 'package main');

    const detector = new ServiceBoundaryDetector({ repoPath: testDir });
    const results = await detector.detect();

    const svc = results.find((r) => r.servicePath === testDir);
    expect(svc).toBeDefined();
    expect(svc!.serviceName).toBe('billing-service');
  });
});
