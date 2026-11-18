// live-grant-lookup.test.ts — the principal admin's grant lookup reads the Nylas key live (#2361, R7).
import { describe, it, expect, vi } from 'vitest';
import { createLiveGrantLookup } from '../../../src/nylas/live-grant-lookup.js';
import { createNylasSignInReaders, NYLAS_API_KEY_SECRET, NYLAS_REGION_SECRET } from '../../../src/nylas/signin-readiness.js';
import { MissingNylasApiKeyError } from '../../../src/principal-mailboxes/types.js';
import { createSilentLogger } from '../../../src/logger.js';

function build(env: NodeJS.ProcessEnv = {}) {
  const vault = new Map<string, string>();
  const lookup = vi.fn(async () => ({ email: 'boss@example.com', provider: 'google' }));
  const readers = createNylasSignInReaders({ secrets: { get: async (n) => vault.get(n) ?? null }, env, logger: createSilentLogger() });
  return { vault, lookup, fn: createLiveGrantLookup({ ...readers, lookup }) };
}

describe('createLiveGrantLookup', () => {
  it('uses a key and region written to the vault after it was built', async () => {
    const { vault, lookup, fn } = build();
    await expect(fn('g-1')).rejects.toBeInstanceOf(MissingNylasApiKeyError);
    expect(lookup).not.toHaveBeenCalled();
    vault.set(NYLAS_API_KEY_SECRET, 'nyk_late');
    vault.set(NYLAS_REGION_SECRET, 'eu');
    await expect(fn('g-1')).resolves.toEqual({ email: 'boss@example.com', provider: 'google' });
    expect(lookup).toHaveBeenCalledWith('nyk_late', 'https://api.eu.nylas.com', 'g-1');
  });

  it('falls back to the environment, and to the us region', async () => {
    const { lookup, fn } = build({ NYLAS_API_KEY: 'nyk_env' });
    await fn('g-2');
    expect(lookup).toHaveBeenCalledWith('nyk_env', 'https://api.us.nylas.com', 'g-2');
  });

  it('the missing-key error carries no key or grant id', async () => {
    const { fn } = build();
    const err = await fn('grant-SECRET').then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(MissingNylasApiKeyError);
    expect(err!.message).not.toContain('grant-SECRET');
  });
});
