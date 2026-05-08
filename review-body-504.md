## Review: Changes Requested ❌

**All CI checks are failing.** `npm ci` rejects the lock file because it's out of sync with `package.json`.

### Root Cause

```
npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.
npm error Missing: @emnapi/core@1.10.0 from lock file
npm error Missing: @emnapi/runtime@1.10.0 from lock file
npm error Missing: esbuild@0.28.0 from lock file
```

The `@vitest/coverage-v8@4.1.5` dependency was added to `package.json`, but the `package-lock.json` wasn't fully regenerated. The lock file is missing transitive dependencies (`@emnapi/core`, `@emnapi/runtime`, `esbuild`) that `@vitest/coverage-v8` requires through its `@rolldown/binding-wasm32-wasi` optional dependency chain.

### Required Fix

Regenerate the lock file:
```bash
rm package-lock.json
npm install
git add package-lock.json
git commit --amend
```

The lock file in the PR has 1914 additions and 287 deletions, but it's incomplete — it added new entries for `@rolldown/binding-*` and `lightningcss-*` but missed their required transitive dependencies.

### Also Worth Considering

Adding `@vitest/coverage-v8` as a **root-level** devDependency is unusual since the test runner (`vitest`) lives in `packages/core`. It would be more conventional to add the coverage provider to `packages/core/package.json` where vitest is already a dependency. This would avoid bloating the root `package-lock.json` with platform-specific native bindings (`@rolldown/binding-*`, `lightningcss-*`).

Please fix the lock file sync issue and push. I'll re-review once CI passes.
