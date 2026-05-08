<!-- Closes #639 -->

# Language Feature Support Matrix

This document catalogs the analysis features Astrolabe supports for each language. Features are verified by reading the actual language definition files, parser logic, scope resolver, framework detection, and process tracing code.

Last updated: 2026-05-08

## Feature Matrix

| Language | Imports | Named Bindings | Exports | Heritage | Type Annotations | Constructor Inference | Config Parsing | Frameworks | Entry Points |
|----------|---------|:--------------:|---------|----------|:----------------:|:---------------------:|:--------------:|:----------:|:------------:|
| TypeScript | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| TSX | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| JavaScript | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Python | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Java | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| C# | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| Go | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| Rust | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| PHP | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Ruby | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Swift | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Kotlin | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| C | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| C++ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Protobuf | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Dart | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

**Legend**: ✓ = Supported, ✗ = Not supported, — = Not applicable

## Feature Definitions

| Feature | Description |
|---------|-------------|
| **Imports** | Query patterns for detecting import/require/include statements and their module specifiers |
| **Named Bindings** | Tracks named imports/re-exports at a per-symbol level (e.g. `import { Foo, Bar } from './baz'` resolves each binding separately) |
| **Exports** | Detects whether a symbol is exported from its module (via `export_statement` parent check in tree-sitter AST) |
| **Heritage** | Detects class inheritance (EXTENDS edges) and interface implementation (IMPLEMENTS edges) |
| **Type Annotations** | Extracts parameter types, return types, and modifiers (visibility, static, async, abstract) from function/method nodes |
| **Constructor Inference** | Scope resolver resolves `this`/`self` references to the enclosing class, builds MRO for method resolution |
| **Config Parsing** | Reads project configuration files (package.json, go.mod, Cargo.toml, etc.) to detect frameworks and dependencies |
| **Frameworks** | Route detection (Express, FastAPI, Spring Boot, etc.), ORM model detection (Prisma, Mongoose, etc.), and tool/handler detection |
| **Entry Points** | Multi-factor scoring of functions/methods as execution entry points (file name heuristics, call graph position, etc.) |

---

## Per-Language Details

### TypeScript

**Extensions**: `.ts`, `.mts`, `.cts`, `.vue`

**Imports**: 4 patterns — named imports, default imports, mixed default+named, namespace imports (`import * as`). Side-effect imports handled as fallback.

**Named Bindings**: ✓ Each `import_specifier` in named imports is tracked individually. Default + named mixed imports are resolved.

**Exports**: ✓ Checked via parent `export_statement` node detection in the AST.

**Heritage**: ✓ 2 patterns — `extends` (EXTENDS edges), `implements` (IMPLEMENTS edges). Also detects abstract classes.

**Type Annotations**: ✓ Full support. Extracts: `parameterTypes`, `returnType`, `visibility` (public/private/protected), `isStatic`, `isAsync`, `isAbstract` from function_declaration, arrow_function, and method_definition nodes.

**Constructor Inference**: ✓ Uses the `typescript` scope resolver. Walk-up MRO with interface support. Tolerates ±2 arity for optional params.

**Config Parsing**: ✓ `package.json` (dependencies + devDependencies).

**Frameworks**: Express, Fastify, Hapi, Koa, Next.js (App Router + Pages Router), NestJS, Nuxt, Remix, tRPC, Expo Router. ORMs: Prisma, TypeORM, Sequelize, Mongoose, Knex, Drizzle. Tools: MCP tools, tRPC, GraphQL resolvers, Fastify plugins, Slack commands. Decorator patterns for NestJS, Angular, etc.

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.(ts|tsx|js|jsx)`. Route/tool handler detection, middleware WRAPS edges, exported status.

---

### TSX

**Extensions**: `.tsx`

**Imports**: Same as TypeScript (shared `importPatterns`).

**Named Bindings**: Same as TypeScript.

**Exports**: ✓ Same export_statement parent check.

**Heritage**: Same as TypeScript patterns (extends, implements).

**Type Annotations**: Same as TypeScript (handled by the same metadata extraction function).

**Constructor Inference**: ✓ Uses the `typescript` scope resolver (shared).

**Config Parsing**: ✓ Same as TypeScript (npm ecosystem).

**Frameworks**: Same as TypeScript plus JSX-specific route detection (Next.js App Router pages, etc.).

**Entry Points**: ✓ Same as TypeScript.

---

### JavaScript

**Extensions**: `.js`, `.mjs`, `.cjs`, `.jsx`

**Imports**: 4 patterns — same as TypeScript minus `import type`. Side-effect imports as fallback.

**Named Bindings**: ✓ Same named import resolution as TypeScript.

**Exports**: ✓ Same `export_statement` parent check.

**Heritage**: ✗ No `class_heritage`, `extends`, or `implements` queries. Class declarations detected but inheritance edges not extracted.

**Type Annotations**: ✓ Extracts metadata for JS functions (visibility, static, async, abstract modifiers). Parameter types and return types are **not** available in plain JavaScript (only from JSDoc, which is not currently parsed).

**Constructor Inference**: ✓ Uses the shared `typescript` scope resolver.

**Config Parsing**: ✓ `package.json`.

**Frameworks**: Same as TypeScript/TSX. All JS/TS framework detections apply.

**Entry Points**: ✓ Same as TypeScript.

---

### Python

**Extensions**: `.py`, `.pyw`

**Imports**: 6 patterns — `import`, `import as`, `from X import Y`, multi-import, `from X import *`. Wildcard imports detected as import with source-only capture.

**Named Bindings**: ✗ Import semantics set to `namespace` — entire module namespace is imported, individual bindings not tracked.

**Exports**: ✗ No `export_statement` in Python grammar. Python has no syntax-level export keyword (all top-level definitions are importable).

**Heritage**: ✓ Detects `class Foo(Bar):` — captures `Bar` as EXTENDS relationship.

**Type Annotations**: ✓ Extracts: `parameterTypes` (from typed_parameter / typed_default_parameter nodes), `returnType` (from return_type field), `isAsync`, `visibility` (convention-based: `__prefix` = private, `_prefix` = protected).

**Constructor Inference**: ✓ Full Python scope resolver with C3 linearization MRO strategy. Implicit receiver inference for method resolution.

**Config Parsing**: ✓ `requirements.txt` (word-boundary matching), `pyproject.toml`, `manage.py` (Django detection).

**Frameworks**: FastAPI (`@router.get` decorators), Flask (`@app.route` decorators), Django (`path()` calls in urls.py). Django REST Framework (`@api_view`, `@action` decorators). ORMs: SQLAlchemy model detection (class extends db.Model/Base), Django models (classes in models.py). Middleware: FastAPI Depends(), Django decorators (`@login_required`, etc.).

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.py`.

---

### Java

**Extensions**: `.java`

**Imports**: 2 patterns — qualified imports and `import X.*` (asterisk/wildcard). Both via `import_declaration` with `scoped_identifier`.

**Named Bindings**: ✗ Import semantics set to `named` but individual named imports are not tracked per-symbol (whole scoped_identifier is captured).

**Exports**: ✗ No `export_statement` in Java grammar. Java doesn't have a module export keyword.

**Heritage**: ✓ 2 patterns — `extends` (EXTENDS edges) and `implements` (IMPLEMENTS edges). Detected from superclass and super_interfaces in class_declaration.

**Type Annotations**: ✓ Extracts: `visibility` (public/private/protected from modifiers), `isStatic`, `isAbstract`, `returnType` (from method_declaration type field), `parameterTypes`.

**Constructor Inference**: ✓ Full Java scope resolver with single-inheritance MRO. Package-path import resolution. Strict arity matching.

**Config Parsing**: ✗ No `pom.xml`, `build.gradle`, or `build.gradle.kts` parsing.

**Frameworks**: Spring Boot (`@GetMapping`, `@PostMapping`, `@RequestMapping` detection). No ORM-specific detection for Java (Hibernate/JPA not specifically scanned).

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.java`.

---

### C#

**Extensions**: `.cs`

**Imports**: 1 pattern — `using` directives via `using_directive` with `identifier_or_type_name`.

**Named Bindings**: ✗ Only detects the using directive name as a whole.

**Exports**: ✗ No `export_statement` in C# grammar. C# uses namespace organization, not file-level export keywords.

**Heritage**: ✗ No `extends` or `implements` query patterns. Class, interface, struct, enum, record definitions all detected but inheritance edges not extracted.

**Type Annotations**: ✓ Extracts: `visibility` (public/private/protected/internal from modifiers), `isStatic`, `isAsync`, `isAbstract`, `returnType` (from method_declaration type field), `parameterTypes`.

**Constructor Inference**: ✓ Full C# scope resolver with single-inheritance MRO. Namespace-based import resolution. Tolerates ±1 arity for optional params.

**Config Parsing**: ✗ No `.csproj`, `.sln`, or `NuGet.config` parsing.

**Frameworks**: ✗ No route patterns for ASP.NET Core (e.g., `[HttpGet]`, `MapGet`, etc.).

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.cs`.

---

### Go

**Extensions**: `.go`

**Imports**: 3 patterns — bare import (`import "package"`), aliased import (`import alias "package"`), dot import (`. "package"`).

**Named Bindings**: ✗ Import semantics set to `wildcard-leaf` — imports resolve to the entire package namespace.

**Exports**: ✗ No `export_statement` in Go grammar. Exports are determined by capitalization convention (not currently detected).

**Heritage**: ✗ No `extends`/`implements` patterns. Struct embedding is documented in the comment but no tree-sitter query captures it.

**Type Annotations**: ✗ No metadata extraction for Go functions/methods.

**Constructor Inference**: ✗ Not in the SCOPE_RESOLVERS map.

**Config Parsing**: ✓ `go.mod` (parses `require`, `module` directives for framework detection).

**Frameworks**: Config-based: gin, echo, gorilla-mux, chi, fiber (detected from go.mod). Route patterns: none (no Go framework-specific route regex patterns in routes.ts). ORMs: none specifically for Go.

**Known Limitations**: Go constructor patterns (`NewXxx` functions) are documented but not automatically inferred as constructors. Struct embedding is not captured as inheritance edges. No method/function type extraction.

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.go`.

---

### Rust

**Extensions**: `.rs`

**Imports**: 3 patterns — qualified `use crate::module::Type`, aliased `use X as Y`, grouped `use module::{Type1, Type2}`.

**Named Bindings**: ✗ Import semantics set to `named` but grouped imports capture individual names separately via `use_list`.

**Exports**: ✗ No `export_statement` in Rust grammar. `pub` keyword not checked.

**Heritage**: ✗ No explicit `extends`/`implements` patterns. Trait implementations (`impl TraitName for TypeName`) are captured as Impl nodes but not as inheritance edges. `#[derive(...)]` attributes not extracted.

**Type Annotations**: ✗ No metadata extraction for Rust functions.

**Constructor Inference**: ✗ Not in the SCOPE_RESOLVERS map.

**Config Parsing**: ✓ `Cargo.toml` (word-boundary matching for dependencies).

**Frameworks**: Config-based: actix-web, rocket, axum, warp, tide, tokio (detected from Cargo.toml). Route patterns: none (no Rust framework route regex in routes.ts). ORMs: none specifically detected.

**Known Limitations**: `#[derive(...)]` and `#[macro_use]` attributes not extracted. Trait inheritance (`trait Foo: Bar`) not captured. No parameter/return type extraction.

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.rs`.

---

### PHP

**Extensions**: `.php`

**Imports**: 1 pattern — `use` declarations via `use_declaration` with `name` capture.

**Named Bindings**: ✗ Detects `use Foo\Bar\Baz` as a single import.

**Exports**: ✗ No `export_statement` in PHP grammar.

**Heritage**: ✗ No `extends`/`implements` query patterns. Class, interface, trait, enum detected but inheritance not extracted.

**Type Annotations**: ✗ No metadata extraction for PHP functions.

**Constructor Inference**: ✗ Not in the SCOPE_RESOLVERS map.

**Config Parsing**: ✗ No `composer.json` parsing.

**Frameworks**: Route-based: Laravel (`Route::get/post/etc`). Middleware: Laravel `->middleware()` chain. Blade template form actions detected. ORMs: none specifically detected.

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.php`.

---

### Ruby

**Extensions**: `.rb`

**Imports**: 1 pattern — `require`/`require_relative` calls. Uses predicate match to avoid false positives on other method calls.

**Named Bindings**: ✗ Import semantics set to `wildcard-leaf` — imports resolve to full file/module scope.

**Exports**: ✗ No `export_statement` in Ruby grammar.

**Heritage**: ✗ No `extends`/`includes` query patterns for Ruby class inheritance or module inclusion.

**Type Annotations**: ✗ No metadata extraction for Ruby.

**Constructor Inference**: ✗ Not in the SCOPE_RESOLVERS map.

**Config Parsing**: ✗ No `Gemfile` parsing.

**Frameworks**: Route-based: Rails is listed in the framework detection but there are no specific Ruby route detection patterns in routes.ts. ORMs: none.

**Known Limitations**: Ruby `include`/`extend` module mixins not captured. No class/module inheritance edges. No Rails controller route detection patterns.

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.rb`.

---

### Swift

**Extensions**: `.swift`

**Imports**: 2 patterns — simple `import Module` and qualified `import Module.Submodule` (navigation_suffix).

**Named Bindings**: ✗ Import semantics set to `wildcard-leaf`.

**Exports**: ✗ No `export_statement` in Swift grammar.

**Heritage**: ✗ No extends/implements patterns. Class, struct, enum, protocol detected but no inheritance edges.

**Type Annotations**: ✗ No metadata extraction for Swift.

**Constructor Inference**: ✗ Not in the SCOPE_RESOLVERS map.

**Config Parsing**: ✗ No `Package.swift` parsing.

**Frameworks**: ✗ No Swift/iOS framework detection patterns.

**Known Limitations**: `: SuperClass` syntax in class declarations not captured as EXTENDS edges. Protocol conformance not tracked.

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.swift`.

---

### Kotlin

**Extensions**: `.kt`, `.kts`

**Imports**: 2 patterns — `import package.Type` and `import package.*` (wildcard).

**Named Bindings**: ✗ Detects import source and name but not per-symbol tracking.

**Exports**: ✗ No `export_statement` in Kotlin grammar.

**Heritage**: ✗ No `: SuperClass` or `: Interface` query patterns. class, interface, object, enum detected but inheritance not extracted.

**Type Annotations**: ✗ No metadata extraction for Kotlin.

**Constructor Inference**: ✗ Not in the SCOPE_RESOLVERS map.

**Config Parsing**: ✗ No `build.gradle.kts` parsing.

**Frameworks**: ✗ No Kotlin/Android framework detection patterns.

**Known Limitations**: Kotlin data classes, sealed classes, and companion objects detected via `class_declaration` / `object_declaration` but not specially labeled. No Spring Boot/Ktor route detection. No extension function tracking.

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.kt`.

---

### C

**Extensions**: `.c`, `.h`

**Imports**: 2 patterns — `#include "file.h"` (string_literal) and `#include <file.h>` (system_lib_string).

**Named Bindings**: ✗ Import semantics set to `wildcard-transitive` — all symbols from included files are transitively available.

**Exports**: ✗ No `export_statement` in C grammar. C has no module system — all non-static symbols have external linkage.

**Heritage**: ✗ No class/inheritance in C.

**Type Annotations**: ✗ No metadata extraction for C.

**Constructor Inference**: ✗ Not in the SCOPE_RESOLVERS map. `mroStrategy: 'none'`.

**Config Parsing**: ✗ No `Makefile` or `CMakeLists.txt` parsing.

**Frameworks**: ✗ No C framework detection patterns.

**Known Limitations**: No macro definition extraction (significant for C codebases). `typedef struct` aliases detected as Typedef but struct tags are separate. Function pointers not tracked.

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.c`.

---

### C++

**Extensions**: `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`

**Imports**: 2 patterns — same `#include` patterns as C.

**Named Bindings**: ✗ Same `wildcard-transitive` as C.

**Exports**: ✗ Same as C.

**Heritage**: ✗ No inheritance patterns. Class, struct, enum detected but no `public Base`, `virtual` inheritance, or interface edges.

**Type Annotations**: ✗ No metadata extraction for C++.

**Constructor Inference**: ✗ Not in the SCOPE_RESOLVERS map.

**Config Parsing**: ✗ No `CMakeLists.txt`, `Makefile`, or build system parsing.

**Frameworks**: ✗ No C++ framework detection patterns.

**Known Limitations**: No template specialization tracking (template_declaration captured but just the function name). No `virtual`/`override` method detection. No namespace alias resolution. No `public:/private:/protected:` section parsing.

**Entry Points**: ✓ File name heuristic: `index|main|app|server|cli|start|bootstrap|run.cpp`.

---

### Protobuf

**Extensions**: `.proto`

**Imports**: 1 pattern — `import "path/to/file.proto"`.

**Named Bindings**: ✗ Import semantics set to `named`.

**Exports**: ✗ No export concept in Protobuf — all messages, enums, services are public within a package.

**Heritage**: ✗ No inheritance in Protobuf (proto3 removed extensions; proto2 `extend` not captured).

**Type Annotations**: ✗ No metadata extraction.

**Constructor Inference**: ✗ Not in the SCOPE_RESOLVERS map. `mroStrategy: 'none'`.

**Config Parsing**: ✗ No `buf.yaml` or protobuf config parsing.

**Frameworks**: ✗ No gRPC framework detection via config files. gRPC RPC methods are detected in tools.ts as gRPC tools (proto-only patterns).

**Tools Detection**: ✓ gRPC tools: `rpc MethodName(...)` is detected as a gRPC tool node.

**Known Limitations**: The protobuf grammar (`coder3101/tree-sitter-proto`) captures messages as Class, services as Interface, RPCs as Method, oneofs as Union — these labels are approximations of proto concepts. No `option` statement extraction.

**Entry Points**: ✗ Not supported. `.proto` is not in the `ENTRY_FILE_NAMES` regex.

---

### Dart

**Status**: ❌ Not Implemented

Dart is listed in the README as a supported language and appears in the entry-point file name regex (`.dart` extension). However, **no Dart language definition file exists**.

- No `packages/core/src/analysis/languages/dart.ts`
- No tree-sitter grammar WASM file for Dart
- Not in `languages/index.ts` registry
- No type extraction, scope resolver, config parsing, or framework detection for Dart

Dart is effectively unsupported and should be removed from the supported languages list or implemented.

---

## Framework Detection Summary

### Route Detection (`routes.ts`)

| Language Ecosystem | Frameworks Detected | Detection Method |
|--------------------|---------------------|------------------|
| TypeScript/JavaScript | Express, Fastify, Hapi, Koa, NestJS, Next.js (App Router + Pages Router), Expo Router | Regex patterns + file-path heuristics |
| Python | FastAPI, Flask, Django, Django REST Framework | Regex patterns (decorators, `path()` calls) |
| PHP | Laravel, Blade templates, HTML forms, Pug templates | Regex patterns + form action extraction |
| Java | Spring Boot (`@GetMapping`, `@PostMapping`, `@RequestMapping`) | Regex patterns |
| All ecosystems | HTML templates (form actions) | Template file scanning |

### ORM Detection (`orm.ts`)

| Ecosystem | ORMs Detected | Detection Method |
|-----------|---------------|------------------|
| All (schema-driven) | Prisma | `prisma/schema.prisma` model detection |
| Python | Django ORM, SQLAlchemy | Models in `models.py` + import scanning |
| TypeScript/JavaScript | TypeORM (`@Entity`), Sequelize (`define`), Mongoose (`model`), Supabase (`from`, `rpc`) | Content scanning + import tracking |

### Framework Config Detection (`framework-detection.ts`)

| Ecosystem | Config File | Frameworks Detected |
|-----------|-------------|---------------------|
| npm | `package.json` | next, express, fastify, koa, nest, remix, nuxt, trpc + ORMs (prisma, typeorm, sequelize, drizzle, knex, mongoose) |
| Python | `requirements.txt`, `pyproject.toml`, `manage.py` | flask, fastapi, django, aiohttp, sanic, starlette + ORMs (sqlalchemy, peewee, tortoise, pony) |
| Go | `go.mod` | gin, echo, gorilla-mux, chi, fiber |
| Rust | `Cargo.toml` | actix-web, rocket, axum, warp, tide, tokio |

### Tool/Handler Detection (`tools.ts`)

| Tool Type | Language Scope | Pattern |
|-----------|---------------|---------|
| MCP tools | JS/TS | `server.tool('name', ...)` |
| MCP resources | JS/TS | `server.resource('name', ...)` |
| tRPC | JS/TS | `.query()`, `.mutation()`, `.procedure()` |
| CLI commands | JS/TS (Commander) | `.command('name')` |
| gRPC | Protobuf-only | `rpc MethodName(...)` |
| GraphQL resolvers | JS/TS | `Query: { field }`, `Mutation: { action }` |
| Fastify plugins | JS/TS | `fastify.decorate('name', ...)` |
| Slack commands | JS/TS | `app.command('name', ...)` |

---

## Scope Resolver Coverage

Only 6 language variants have custom scope resolvers for constructor inference and import resolution:

| Language | Resolver | MRO Strategy | Import Resolution | Notes |
|----------|----------|-------------|-------------------|-------|
| TypeScript | `typescriptResolver` | Walk-up with interface support | Relative/aliased/bare specifiers | ±2 arity tolerance |
| TSX | Shared with TypeScript | Same | Same | Same |
| JavaScript | Shared with TypeScript | Same | Same | Same |
| Python | `pythonResolver` | C3 linearization | Dotted module paths → file paths | Implicit receiver inference |
| Java | `javaResolver` | Single inheritance walk-up | Package paths (com.example.Service) | Strict arity |
| C# | `csharpResolver` | Single inheritance walk-up | Namespace paths (MyApp.Services.UserService) | ±1 arity tolerance |

All other languages (Go, Rust, PHP, Ruby, Swift, C, C++, Kotlin, Protobuf) do not have scope resolvers and rely on the legacy resolution DAG.

---

## Metadata (Type Annotation) Extraction

The `extractSymbolMetadata()` function in `parser.ts` dispatches to language-specific helpers:

| Language | parameterTypes | returnType | visibility | isStatic | isAsync | isAbstract |
|----------|:--------------:|:----------:|:----------:|:--------:|:-------:|:----------:|
| TypeScript / TSX | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| JavaScript | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| Python | ✓ | ✓ | ✓¹ | ✗ | ✓ | ✗ |
| Java | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| C# | ✓ | ✓ | ✓² | ✓ | ✓ | ✓ |
| All others | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

¹ Python visibility is convention-based (`_prefix` = protected, `__prefix` = private, excluding `__dunder__`).  
² C# includes `internal` visibility modifier.

---

## Known Limitations

### General
- Export detection only works for TypeScript/JavaScript (relies on `export_statement` parent node check). Other languages don't have tree-sitter `export_statement` nodes.
- The `cross-file` phase for type propagation is partially implemented (builds type maps and topological ordering but doesn't emit type-reference relationships yet — see issue #234).

### Language-Specific
- **Go**: Struct embedding not captured as heritage edges. `NewXxx` constructor patterns not inferred. No type extraction.
- **Rust**: `#[derive(...)]`, trait inheritance (`trait Foo: Bar`), and `impl Trait for Type` are not captured as heritage edges. No type extraction.
- **C/C++**: No macro tracking, no `virtual`/`override` detection, no template specialization. Preprocessor includes are wildcard-transitive (every symbol from every included header is considered available).
- **Kotlin/Swift**: Minimal feature set. No heritage edges, no type extraction, no framework detection. Both were added as language definitions with basic symbol/import queries only.
- **Ruby**: Only `require`/`require_relative` detected as imports. No Rails route detection patterns in routes.ts. No `include`/`extend` mixin detection.
- **PHP**: No `composer.json` parsing. No extends/implements queries despite PHP supporting OOP inheritance.
- **Protobuf**: Labels are approximations (messages → Class, services → Interface, RPCs → Method). Entry points not supported (`.proto` excluded from entry file name regex).
- **Dart**: Listed in README but has no implementation at all.
