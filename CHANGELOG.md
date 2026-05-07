# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

Releases are auto-generated from conventional commits. See [GitHub Releases](https://github.com/danielperezr88/astrolabe/releases) for detailed release notes.

## [0.2.0] — Unreleased

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
