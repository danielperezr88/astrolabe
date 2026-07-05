import { describe, it, expect } from 'vitest';
import { parseUnifiedDiffWithLineNumbers } from '../../src/analysis/detect-changes.js';

describe('parseUnifiedDiffWithLineNumbers', () => {
  it('parses added lines in a single file', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
index a1b2c3d..e4f5g6h 100644
--- a/src/test.ts
+++ b/src/test.ts
@@ -10,0 +11 @@ function foo() {
+  console.log("hello");
@@ -20,0 +22 @@ function bar() {
+  return 42;
`;

    const result = parseUnifiedDiffWithLineNumbers(diff);

    expect(result['src/test.ts']).toBeDefined();
    const addedLines = result['src/test.ts'].addedLines;
    expect(addedLines.has(11)).toBe(true);
    expect(addedLines.has(22)).toBe(true);
    expect(addedLines.size).toBe(2);
  });

  it('parses removed lines', () => {
    const diff = `diff --git a/src/old.ts b/src/old.ts
index a1b2c3d..e4f5g6h 100644
--- a/src/old.ts
+++ b/src/old.ts
@@ -40 +39,0 @@ function baz() {
-  const x = 1;
`;

    const result = parseUnifiedDiffWithLineNumbers(diff);

    expect(result['src/old.ts']).toBeDefined();
    const removedLines = result['src/old.ts'].removedLines;
    expect(removedLines.has(40)).toBe(true);
    expect(removedLines.size).toBe(1);
  });

  it('handles multiple files', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -5,0 +6 @@
+added
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -15,0 +16 @@
+also_added
`;

    const result = parseUnifiedDiffWithLineNumbers(diff);

    expect(result['src/a.ts']).toBeDefined();
    expect(result['src/b.ts']).toBeDefined();
    expect(result['src/a.ts'].addedLines.has(6)).toBe(true);
    expect(result['src/b.ts'].addedLines.has(16)).toBe(true);
  });

  it('returns empty for no changes', () => {
    const result = parseUnifiedDiffWithLineNumbers('');
    expect(Object.keys(result).length).toBe(0);
  });

  it('handles context lines (space-prefixed) advancing both counters', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -10,0 +11,2 @@ function foo() {
+  const x = 1;
+  const y = 2;
@@ -25,1 +27,0 @@ function bar() {
-  const z = 3;
`;

    const result = parseUnifiedDiffWithLineNumbers(diff);

    const added = result['src/test.ts'].addedLines;
    expect(added.has(11)).toBe(true);
    expect(added.has(12)).toBe(true);

    const removed = result['src/test.ts'].removedLines;
    expect(removed.has(25)).toBe(true);
  });
});
