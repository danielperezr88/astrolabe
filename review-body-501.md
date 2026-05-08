## Review: Requested Changes

### Critical Issues

**1. Dependency Review job will always fail** ❌

```
##[error]Dependency review is not supported on this repository. Please ensure that 
Dependency graph is enabled, see https://github.com/danielperezr88/astrolabe/settings/security_analysis
```

The `dependency-review-action` requires the GitHub Dependency Graph to be enabled in repository settings. Until that's enabled at `Settings > Security analysis > Dependency graph`, this job will fail on every PR. Either:
- Enable the dependency graph in repo settings, OR
- Gate the job with `continue-on-error: true` until the setting is enabled

**2. Trivy uses `@master` instead of pinned version** ⚠️

```yaml
uses: aquasecurity/trivy-action@master
```

Pinning to `@master` means any commit to the upstream repo will be used without review. This is a supply chain risk in a security-focused PR. Pin to a specific release tag (e.g., `@0.30.0`) or commit SHA.

### Minor Issues

**3. npm audit `|| true` swallows all errors**

```yaml
- name: Run npm audit
  run: npm audit --audit-level=high --omit=dev || true
```

The `|| true` means this step never fails, even if npm audit itself crashes (network timeout, corrupted lockfile, etc.). Consider splitting into two steps: one that always runs for visibility, and the critical check that actually fails.

### What's Good

- **CodeQL config** is solid: `security-extended,security-and-quality` queries provide thorough analysis
- **npm audit severity split** (warn on high, fail on critical) is a reasonable approach
- **Trivy scan on Docker images** for RC and release is a good defense-in-depth measure
- **All other CI checks pass** (Unit Tests, Docker Build, Integration Tests)

### Recommended Fix

Before merging, please:
1. Pin Trivy to a specific version: `aquasecurity/trivy-action@0.30.0`
2. Either enable Dependency Graph in repo settings, or add `continue-on-error: true` to the dependency-review job with a TODO comment
