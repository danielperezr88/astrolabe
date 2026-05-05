/**
 * Astrolabe Error Hierarchy — structured error types for API responses.
 *
 * Base class `AstrolabeError` carries a machine-readable code, HTTP status,
 * and optional details. Domain-specific subclasses provide semantic meaning
 * so API consumers can handle specific failure modes programmatically.
 *
 * @module errors
 */

// ── Base Error ──────────────────────────────────────────────────────────────

export class AstrolabeError extends Error {
  /** Machine-readable error code (e.g. 'PARSE_001') */
  readonly code: string;
  /** HTTP status code */
  readonly statusCode: number;
  /** Arbitrary structured details for debugging */
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AstrolabeError';
    this.code = code;
    this.statusCode = statusCode;
    if (details) this.details = details;
  }

  /** Serialize for JSON API responses */
  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      code: this.code,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

// ── Domain-Specific Errors ─────────────────────────────────────────────────

/** Tree-sitter parsing failures */
export class ParseError extends AstrolabeError {
  constructor(
    message: string,
    code: string = 'PARSE_001',
    details?: Record<string, unknown>,
  ) {
    super(message, code, 422, details);
    this.name = 'ParseError';
  }
}

/** Graph construction / query failures */
export class GraphError extends AstrolabeError {
  constructor(
    message: string,
    code: string = 'GRAPH_001',
    details?: Record<string, unknown>,
  ) {
    super(message, code, 500, details);
    this.name = 'GraphError';
  }
}

/** Invalid search queries or bad user input */
export class QueryError extends AstrolabeError {
  constructor(
    message: string,
    code: string = 'QUERY_001',
    details?: Record<string, unknown>,
  ) {
    super(message, code, 400, details);
    this.name = 'QueryError';
  }
}

/** Repo / symbol not found */
export class NotFoundError extends AstrolabeError {
  constructor(
    message: string,
    code: string = 'NOT_FOUND',
    details?: Record<string, unknown>,
  ) {
    super(message, code, 404, details);
    this.name = 'NotFoundError';
  }
}

/** Analysis pipeline failures */
export class AnalysisError extends AstrolabeError {
  constructor(
    message: string,
    code: string = 'ANALYSIS_001',
    details?: Record<string, unknown>,
  ) {
    super(message, code, 500, details);
    this.name = 'AnalysisError';
  }
}

/** Configuration issues (invalid env vars, missing config) */
export class ConfigError extends AstrolabeError {
  constructor(
    message: string,
    code: string = 'CONFIG_001',
    details?: Record<string, unknown>,
  ) {
    super(message, code, 400, details);
    this.name = 'ConfigError';
  }
}

/** Type guard — checks if an error is an AstrolabeError */
export function isAstrolabeError(err: unknown): err is AstrolabeError {
  return err instanceof AstrolabeError;
}
