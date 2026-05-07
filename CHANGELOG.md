# Changelog

## [1.0.3] — 2026-05-07

### 🐛 Bug Fixes

- release check trigger only inspects first line of commit message (6c740f4)
- configure git identity and filter CHANGELOG commits in release pipeline (6474b22)

## [1.0.1] — 2026-05-07

### 🐛 Bug Fixes

- smoke test health check endpoint and version collision detection (#1) (502eef3)
- revert console.error(err.stack) — log-injection risk, false-positive stack-trace alerts dismissed (#1) (2f9827b)
- log stack traces to stderr instead of HTTP response body to prevent stack-trace exposure (#1) (7d49851)
- use explicit instanceof guard with early return for stack-trace sanitization (#1) (6b3ef3d)
- resolve CodeQL regressions — stack-trace sanitization and dead assignment (#1) (9938c54)
- resolve remaining CodeQL alerts with iterative regex and TOCTOU extraction (#1) (cbb4508)
- resolve all 58 CodeQL scanning alerts (9d06af3)
- make GitHub release step idempotent for re-runs (ade2a67)
- use inline .npmrc for npm publish auth (863f241)
- add npm scope and explicit auth config for publish step (a4471a1)
- remove version bump from release pipeline to prevent npm corruption (c8f34c0)
- make version bump push non-fatal when branch protected (3a2b439)
- set trivy exit-code to 0 (report vulns without blocking) (7f92019)
- update trivy-action to v0.36.0 (0.30.0 never existed) (cbc387c)
- build packages/core in rc.yml and release.yml test gates (#556) (748e7ca)
- nextRelease() to check seed tags for correct major version (#557) (83b1587)
- upgrade @ladybugdb/core to 0.16.1 and fix CI optional deps (#556) (b586fde)
- graceful shutdown drains active connections (#495) (bd7d268)
- add structured logging to all silent catch blocks (#488) (f910851)
- CI coverage report and release.yml packages/web bug (#498, #499) (#504) (c01809e)
- command injection in release-notes.mjs and next-version.mjs (#481) (#500) (92097fe)

### 📚 Documentation

- add mandatory release flow enforcement and admin bypass prohibition (#1) (7f7dbcc)
- update CHANGELOG for v1.0.0 release (67a05e0)
- add CHANGELOG.md with auto-update in release pipeline (#493) (3cfc43b)
- add .env.example with documented environment variables (#494) (5881fef)
- add CONTRIBUTING.md and GitHub issue templates (#492) (07d2d36)

### 🔧 Refactoring

- rename remaining @astrolabe imports to @astrolabe-dev (f1c9290)
- rename @astrolabe imports to @astrolabe-dev in source files (26e7d97)
- rename npm scope from @astrolabe to @astrolabe-dev (eb4088b)
- migrate operational console.* calls to structured logger (#486) (#505) (e8b0ba1)

### 🔨 Chore

- fix remaining workspace dep specs in core and lockfile (709c003)
- sync dependency specs and lockfile to v1.0.0 (62fba4c)
- bump versions to 1.0.0, add npm ci to release pipeline (fc1d1c5)
- remove temp files and packages/web workspace (#497) (620cd63)
- update CLAUDE.md with draft PR workflow and issue-PR linking SOPs (#482) (65d8b57)

### 🧪 Tests

- add MCP server end-to-end integration tests (#536) (ec71004)
- add CLI integration tests with subprocess execution (#537) (4244ed6)
- add graceful shutdown integration tests (#535) (7b12004)
- add HTTP server integration tests (#534) (7d461ce)

### 🚀 Features

- add rollback workflow and deployment smoke tests (#496) (#517) (8e13177)
- add custom error type hierarchy for API responses (#487) (#509) (ff2d01f)
- CI failure notifications and Node version matrix (#490, #491) (e97f6e3)
- add npm publish step to release pipeline (#489) (#510) (290a570)
- add security scanning to CI pipeline (#484) (#501) (ee770a6)
- add request tracing with x-request-id header (#483) (#503) (37f4078)
- add rate limiting to HTTP server (#485) (#502) (3b41c12)

### Added

- **Security scanning**: CodeQL SAST, npm audit, Trivy Docker image scanning in CI (#484)
- **Rate limiting**: Token-bucket rate limiter on HTTP server (100 req/min/IP, configurable) (#485)
- **Request tracing**: `X-Request-Id` header on every response, preserved from upstream (#483)
- **Structured logger**: JSON logger with `createLogger()`, migrated operational `console.*` calls (#486)
- **Error hierarchy**: `AstrolabeError` base class with domain-specific subclasses for API responses (#487)
- **CI failure notifications**: Auto-create GitHub issue on pipeline failure (#490)
- **Node version matrix**: CI tests on Node 18, 20, and 22 (#491)
- **npm publish**: `@astrolabe/cli` auto-published to npm on release (#489)
- **Environment docs**: `.env.example` documenting all 13 environment variables (#494)

### Fixed

- **Command injection**: `execSync` → `execFileSync` in release/version scripts (#481)
- **CI coverage report**: Artifact upload fix, moved coverage provider to correct workspace (#498, #499)
- **Silent catch blocks**: 19 catch blocks now log at debug level with error context (#488)

### Changed

- **CONTRIBUTING.md**: Added full development workflow and issue templates (#492)
- **Removed**: Non-functional `packages/web` workspace and temp debug artifacts (#497)
