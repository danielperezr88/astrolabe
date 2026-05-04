/**
 * Tests for DB lock retry logic (withRetry, withRetrySync, isDbBusyError).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isDbBusyError, withRetry, withRetrySync } from '../../src/persist/sqlite.js';

// ── isDbBusyError ───────────────────────────────────────────────────────────

describe('isDbBusyError', () => {
  it('detects SQLITE_BUSY code string', () => {
    const err = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    expect(isDbBusyError(err)).toBe(true);
  });

  it('detects numeric code 5 (SQLITE_BUSY)', () => {
    const err = Object.assign(new Error('locked'), { code: 5 });
    expect(isDbBusyError(err)).toBe(true);
  });

  it('detects "database is locked" in message', () => {
    const err = new Error('database is locked');
    expect(isDbBusyError(err)).toBe(true);
  });

  it('detects "busy" in message (case-insensitive)', () => {
    const err = new Error('SQLITE BUSY error');
    expect(isDbBusyError(err)).toBe(true);
  });

  it('returns false for non-busy errors', () => {
    const err = new Error('syntax error near SELECT');
    expect(isDbBusyError(err)).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isDbBusyError('oops')).toBe(false);
    expect(isDbBusyError(null)).toBe(false);
    expect(isDbBusyError(undefined)).toBe(false);
    expect(isDbBusyError(42)).toBe(false);
  });
});

// ── withRetry (async) ──────────────────────────────────────────────────────

describe('withRetry', () => {
  it('returns result on first successful attempt (no retry)', async () => {
    const fn = vi.fn(() => 42);
    const result = await withRetry(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries once then succeeds', async () => {
    const busyErr = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const fn = vi.fn()
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries up to maxAttempts then throws', async () => {
    const busyErr = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const fn = vi.fn().mockRejectedValue(busyErr);
    await expect(withRetry(fn, 3, 10)).rejects.toThrow('database is locked');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-BUSY errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('syntax error'));
    await expect(withRetry(fn, 3, 10)).rejects.toThrow('syntax error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects custom maxAttempts', async () => {
    const busyErr = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    const fn = vi.fn().mockRejectedValue(busyErr);
    await expect(withRetry(fn, 5, 10)).rejects.toThrow('busy');
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('uses exponential backoff (baseDelay × attempt)', async () => {
    const busyErr = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return originalSetTimeout(cb, 0); // resolve immediately for test speed
    });

    const fn = vi.fn()
      .mockRejectedValueOnce(busyErr)
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValueOnce('done');

    await withRetry(fn, 3, 100);
    expect(delays).toEqual([100, 200]); // baseDelay*1, baseDelay*2

    vi.restoreAllMocks();
  });

  it('works with synchronous fn returning a value', async () => {
    const fn = vi.fn(() => 'sync-result');
    const result = await withRetry(fn);
    expect(result).toBe('sync-result');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── withRetrySync ───────────────────────────────────────────────────────────

describe('withRetrySync', () => {
  it('returns result on first successful attempt', () => {
    const fn = vi.fn(() => 99);
    expect(withRetrySync(fn)).toBe(99);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries once then succeeds', () => {
    const busyErr = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const fn = vi.fn()
      .mockImplementationOnce(() => { throw busyErr; })
      .mockReturnValueOnce('ok');
    expect(withRetrySync(fn, 3, 1)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries up to maxAttempts then throws', () => {
    const busyErr = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const fn = vi.fn(() => { throw busyErr; });
    expect(() => withRetrySync(fn, 3, 1)).toThrow('database is locked');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-BUSY errors', () => {
    const fn = vi.fn(() => { throw new Error('constraint violation'); });
    expect(() => withRetrySync(fn, 3, 1)).toThrow('constraint violation');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── withRetry debug logging ────────────────────────────────────────────────

describe('withRetry debug logging', () => {
  const originalDebug = process.env.ASTROLABE_DEBUG;

  beforeEach(() => {
    process.env.ASTROLABE_DEBUG = '1';
  });

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.ASTROLABE_DEBUG;
    } else {
      process.env.ASTROLABE_DEBUG = originalDebug;
    }
  });

  it('logs retry attempts when ASTROLABE_DEBUG is set', async () => {
    const busyErr = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const fn = vi.fn()
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValueOnce('ok');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withRetry(fn, 3, 10);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[db:retry]'),
    );
    spy.mockRestore();
  });
});
