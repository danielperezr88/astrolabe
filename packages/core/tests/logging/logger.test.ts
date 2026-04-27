/**
 * Tests for the structured JSON logger.
 */

import { describe, it, expect } from 'vitest';
import { createLogger } from '../../src/logging/logger.js';

describe('Logger', () => {
  it('writes entries at default info level', () => {
    const log = createLogger({ stderr: false });
    log.info('test message', { count: 1 });
    const entries = log.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].message).toBe('test message');
    expect(entries[0].data).toEqual({ count: 1 });
  });

  it('suppresses debug messages at info level', () => {
    const log = createLogger({ level: 'info', stderr: false });
    log.debug('should not appear');
    log.info('should appear');
    expect(log.entries()).toHaveLength(1);
  });

  it('includes debug messages at debug level', () => {
    const log = createLogger({ level: 'debug', stderr: false });
    log.debug('debug msg');
    expect(log.entries()).toHaveLength(1);
  });

  it('tracks phase timing', () => {
    const log = createLogger({ stderr: false });
    log.phaseStart('scan');
    log.phaseEnd('scan');
    const entries = log.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0].phase).toBe('scan');
    expect(entries[1].elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('writes log entries as JSON strings', () => {
    const log = createLogger({ stderr: false });
    log.info('test');
    const entry = log.entries()[0];
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof entry.timestamp).toBe('string');
  });

  it('handles warn and error levels', () => {
    const log = createLogger({ level: 'warn', stderr: false });
    log.info('should not appear');
    log.warn('warning');
    log.error('error');
    expect(log.entries()).toHaveLength(2);
  });
});
