/**
 * Astrolabe — Design pattern dictionary (#872).
 *
 * Static catalog of detectable design patterns with per-language
 * tree-sitter AST signatures. Consumed by the pattern-detection
 * pipeline phase to create `PatternInstance` nodes in the knowledge graph.
 *
 * Pattern categories:
 * - GoF Creational: Singleton, Factory Method, Builder, Abstract Factory, Prototype
 * - GoF Structural: Adapter, Decorator, Facade, Proxy, Composite
 * - GoF Behavioral: Strategy, Observer, Command, Iterator, Template Method, State
 * - Concurrency: goroutine+channel, async/await
 * - Language idioms: Python decorators, Rust traits, Go functional options
 */

export { PATTERN_CATALOG, getPatternsForLanguage, getPatternById } from './catalog.js';
export type { PatternCategory, PatternDefinition, PatternSignature, ParsedPatternMatch } from '../language-definition.js';
