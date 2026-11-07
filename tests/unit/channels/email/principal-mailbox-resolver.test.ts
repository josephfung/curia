import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { createPrincipalMailboxResolver } from '../../../../src/channels/email/principal-mailbox-resolver.js';
import type { NylasClient } from '../../../../src/channels/email/nylas-client.js';

const logger = pino({ level: 'silent' });

function fakeClient(grant: string): NylasClient {
  return { grant } as unknown as NylasClient;
}

describe('createPrincipalMailboxResolver', () => {
  it('returns null when the grant secret is empty', async () => {
    const createClient = vi.fn();
    const resolve = createPrincipalMailboxResolver({
      secrets: { get: async () => '   ' },
      apiKey: () => 'key',
      logger,
      createClient,
    });
    expect(await resolve()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns null when there is no API key', async () => {
    const createClient = vi.fn();
    const resolve = createPrincipalMailboxResolver({
      secrets: { get: async () => 'grant-1' },
      apiKey: () => undefined,
      logger,
      createClient,
    });
    expect(await resolve()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns null and logs an error when the secret read throws', async () => {
    const errorSpy = vi.fn();
    const log = { ...logger, error: errorSpy } as unknown as typeof logger;
    const resolve = createPrincipalMailboxResolver({
      secrets: { get: async () => { throw new Error('decrypt failed'); } },
      apiKey: () => 'key',
      logger: log,
      createClient: vi.fn(),
    });
    expect(await resolve()).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('reuses the client while the grant is unchanged', async () => {
    const createClient = vi.fn((_k: string, g: string) => fakeClient(g));
    const resolve = createPrincipalMailboxResolver({
      secrets: { get: async () => 'grant-1' },
      apiKey: () => 'key',
      logger,
      createClient,
    });
    const a = await resolve();
    const b = await resolve();
    expect(a).toBe(b);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('builds a new client when the grant changes', async () => {
    let grant = 'grant-1';
    const createClient = vi.fn((_k: string, g: string) => fakeClient(g));
    const resolve = createPrincipalMailboxResolver({
      secrets: { get: async () => grant },
      apiKey: () => 'key',
      logger,
      createClient,
    });
    const a = await resolve();
    grant = 'grant-2';
    const b = await resolve();
    expect(a).not.toBe(b);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenLastCalledWith('key', 'grant-2');
  });
});
