import { describe, it, expect, vi } from 'vitest';
import {
  createDbUnavailableAgentError,
  isDbUnavailableError,
  withDbRetry,
} from '../../../src/db/resilience.js';
import { classifyError } from '../../../src/errors/classify.js';
import { isRetryable } from '../../../src/errors/types.js';

describe('isDbUnavailableError', () => {
  it('detects Node connection refused', () => {
    expect(isDbUnavailableError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('detects pg connection_exception SQLSTATE', () => {
    expect(isDbUnavailableError(Object.assign(new Error('db down'), { code: '08006' }))).toBe(true);
  });

  it('detects admin_shutdown', () => {
    expect(isDbUnavailableError(Object.assign(new Error('shutdown'), { code: '57P01' }))).toBe(true);
  });

  it('detects nested cause', () => {
    const cause = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(isDbUnavailableError(new Error('wrapper', { cause }))).toBe(true);
  });

  it('detects pool connect timeout message', () => {
    expect(
      isDbUnavailableError(new Error('timeout exceeded when trying to connect')),
    ).toBe(true);
  });

  it('does not treat constraint violations as outages', () => {
    expect(isDbUnavailableError(Object.assign(new Error('unique'), { code: '23505' }))).toBe(false);
  });

  it('does not treat plain Error as outage', () => {
    expect(isDbUnavailableError(new Error('something else'))).toBe(false);
  });
});

describe('createDbUnavailableAgentError', () => {
  it('builds a retryable DATABASE_UNAVAILABLE AgentError', () => {
    const err = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const agentErr = createDbUnavailableAgentError('audit', err);
    expect(agentErr.type).toBe('DATABASE_UNAVAILABLE');
    expect(agentErr.retryable).toBe(true);
    expect(isRetryable(agentErr.type)).toBe(true);
    expect(agentErr.source).toBe('audit');
    expect(agentErr.context.code).toBe('ECONNREFUSED');
  });
});

describe('classifyError DB precedence', () => {
  it('preserves AgentError attached by a DB call site', () => {
    const err = Object.assign(new Error('refused'), {
      code: 'ECONNREFUSED',
      agentError: createDbUnavailableAgentError('working-memory', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
    });
    const result = classifyError(err, 'runtime');
    expect(result.type).toBe('DATABASE_UNAVAILABLE');
    expect(result.retryable).toBe(true);
  });

  it('keeps bare ECONNREFUSED as PROVIDER_ERROR (LLM/network, not DB)', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    const result = classifyError(err, 'anthropic');
    expect(result.type).toBe('PROVIDER_ERROR');
  });
});

describe('withDbRetry', () => {
  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    await expect(withDbRetry(fn, { sleep: async () => undefined })).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient DB errors then succeeds', async () => {
    const blip = Object.assign(new Error('blip'), { code: 'ECONNRESET' });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(blip)
      .mockRejectedValueOnce(blip)
      .mockResolvedValueOnce('ok');
    const sleep = vi.fn(async () => undefined);
    await expect(withDbRetry(fn, { sleep, baseDelayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-DB errors immediately', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('unique'), { code: '23505' }));
    await expect(withDbRetry(fn, { sleep: async () => undefined })).rejects.toMatchObject({
      code: '23505',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows after exhausting attempts', async () => {
    const blip = Object.assign(new Error('down'), { code: '57P03' });
    const fn = vi.fn().mockRejectedValue(blip);
    await expect(
      withDbRetry(fn, { maxAttempts: 2, sleep: async () => undefined, baseDelayMs: 1 }),
    ).rejects.toBe(blip);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
