import { describe, it, expect, vi } from 'vitest';
import { resolvePrincipalCalendarGrant } from './resolve-calendar-grant.js';

function secretsReturning(value: string | null) {
  return { get: vi.fn().mockResolvedValue(value) };
}

describe('resolvePrincipalCalendarGrant', () => {
  it('returns the CEO grant when configured', async () => {
    expect(await resolvePrincipalCalendarGrant(secretsReturning('grant_ceo_123'))).toBe('grant_ceo_123');
  });

  it('trims surrounding whitespace', async () => {
    expect(await resolvePrincipalCalendarGrant(secretsReturning('  grant_ceo_123  '))).toBe('grant_ceo_123');
  });

  it('returns undefined (fail closed) when the CEO grant is absent — NO email fallback', async () => {
    expect(await resolvePrincipalCalendarGrant(secretsReturning(null))).toBeUndefined();
  });

  it('returns undefined when the CEO grant is whitespace-only', async () => {
    expect(await resolvePrincipalCalendarGrant(secretsReturning('   '))).toBeUndefined();
  });

  it('propagates a vault read failure (decrypt/DB error must be loud, not swallowed)', async () => {
    const secrets = { get: vi.fn().mockRejectedValue(new Error('vault down')) };
    await expect(resolvePrincipalCalendarGrant(secrets)).rejects.toThrow('vault down');
  });
});
