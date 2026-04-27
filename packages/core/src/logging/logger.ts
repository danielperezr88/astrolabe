/**
 * Structured JSON logging for the Astrolabe pipeline.
 *
 * Provides leveled logging with JSON output, elapsed-time tracking,
 * and per-phase metrics reporting.
 */

import { writeSync, openSync } from 'node:fs';

// ── Types ──────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  phase?: string;
  message: string;
  elapsedMs?: number;
  data?: Record<string, unknown>;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  phaseStart(phase: string): void;
  phaseEnd(phase: string): void;
  /** Return all log entries collected so far. */
  entries(): readonly LogEntry[];
  setLevel(level: LogLevel): void;
}

// ── Implementation ──────────────────────────────────────────────────────────

export function createLogger(
  opts: { level?: LogLevel; output?: string; stderr?: boolean } = {},
): Logger {
  const levelPriority: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  let minLevel = opts.level ?? 'info';
  const entries: LogEntry[] = [];
  const phaseTimers = new Map<string, number>();
  let outFd: number | null = null;

  if (opts.output) {
    outFd = openSync(opts.output, 'a');
  }

  function write(entry: LogEntry): void {
    entries.push(entry);
    const line = JSON.stringify(entry) + '\n';

    if (outFd !== null) {
      writeSync(outFd, line);
    } else if (opts.stderr ?? true) {
      process.stderr.write(line);
    }
  }

  function shouldLog(level: LogLevel): boolean {
    return levelPriority[level] >= levelPriority[minLevel];
  }

  return {
    debug(msg: string, data?: Record<string, unknown>): void {
      if (!shouldLog('debug')) return;
      write({ timestamp: new Date().toISOString(), level: 'debug', message: msg, data });
    },

    info(msg: string, data?: Record<string, unknown>): void {
      if (!shouldLog('info')) return;
      write({ timestamp: new Date().toISOString(), level: 'info', message: msg, data });
    },

    warn(msg: string, data?: Record<string, unknown>): void {
      if (!shouldLog('warn')) return;
      write({ timestamp: new Date().toISOString(), level: 'warn', message: msg, data });
    },

    error(msg: string, data?: Record<string, unknown>): void {
      if (!shouldLog('error')) return;
      write({ timestamp: new Date().toISOString(), level: 'error', message: msg, data });
    },

    phaseStart(phase: string): void {
      phaseTimers.set(phase, Date.now());
      write({ timestamp: new Date().toISOString(), level: 'info', phase, message: `${phase} started` });
    },

    phaseEnd(phase: string): void {
      const start = phaseTimers.get(phase);
      const elapsedMs = start ? Date.now() - start : undefined;
      phaseTimers.delete(phase);
      write({
        timestamp: new Date().toISOString(),
        level: 'info',
        phase,
        message: `${phase} complete`,
        elapsedMs,
      });
    },

    entries(): readonly LogEntry[] {
      return entries;
    },

    setLevel(level: LogLevel): void {
      minLevel = level;
    },
  };
}
