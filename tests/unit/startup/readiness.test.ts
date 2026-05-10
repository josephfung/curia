import { describe, it, expect } from 'vitest';
import { runReadinessChecks } from '../../../src/startup/readiness.js';
import type { ReadinessCheck } from '../../../src/startup/readiness.js';

describe('runReadinessChecks', () => {
  it('returns ready when all checks pass', async () => {
    const checks: ReadinessCheck[] = [
      { name: 'test-check', check: async () => ({ ready: true }) },
    ];
    const result = await runReadinessChecks(checks);
    expect(result.ready).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('returns not ready when a check fails', async () => {
    const checks: ReadinessCheck[] = [
      { name: 'passing', check: async () => ({ ready: true }) },
      { name: 'failing', check: async () => ({ ready: false, reason: 'missing principal contact' }) },
    ];
    const result = await runReadinessChecks(checks);
    expect(result.ready).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('failing');
    expect(result.failures[0].reason).toBe('missing principal contact');
  });

  it('returns not ready when a check throws', async () => {
    const checks: ReadinessCheck[] = [
      { name: 'exploding', check: async () => { throw new Error('boom'); } },
    ];
    const result = await runReadinessChecks(checks);
    expect(result.ready).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('exploding');
    expect(result.failures[0].reason).toContain('boom');
  });

  it('returns ready when checks array is empty', async () => {
    const result = await runReadinessChecks([]);
    expect(result.ready).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});
