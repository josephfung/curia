import { describe, it, expect, vi } from 'vitest';
import { resolvePrincipalCalendarGrant } from './resolve-calendar-grant.js';
import { createSilentLogger } from '../../logger.js';

function secretsReturning(value: string | null) {
  return { get: vi.fn().mockResolvedValue(value) };
}

describe('resolvePrincipalCalendarGrant', () => {
  it('returns the CEO grant when configured', async () => {
    const grant = await resolvePrincipalCalendarGrant(secretsReturning('grant_ceo_123'), createSilentLogger());
    expect(grant).toBe('grant_ceo_123');
  });

  it('trims surrounding whitespace', async () => {
    const grant = await resolvePrincipalCalendarGrant(secretsReturning('  grant_ceo_123  '), createSilentLogger());
    expect(grant).toBe('grant_ceo_123');
  });

  it('returns undefined (fail closed) when the CEO grant is absent — NO email fallback', async () => {
    const grant = await resolvePrincipalCalendarGrant(secretsReturning(null), createSilentLogger());
    expect(grant).toBeUndefined();
  });

  it('returns undefined when the CEO grant is whitespace-only', async () => {
    const grant = await resolvePrincipalCalendarGrant(secretsReturning('   '), createSilentLogger());
    expect(grant).toBeUndefined();
  });

  it('returns undefined and does not throw when the vault read fails', async () => {
    const secrets = { get: vi.fn().mockRejectedValue(new Error('vault down')) };
    const grant = await resolvePrincipalCalendarGrant(secrets, createSilentLogger());
    expect(grant).toBeUndefined();
  });
});
