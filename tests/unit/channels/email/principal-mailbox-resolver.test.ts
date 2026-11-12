import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { createPrincipalMailboxResolver } from '../../../../src/channels/email/principal-mailbox-resolver.js';
import type { NylasClient } from '../../../../src/channels/email/nylas-client.js';
import { PrincipalMailboxes } from '../../../../src/principal-mailboxes/service.js';
import type { PrincipalMailboxStore } from '../../../../src/principal-mailboxes/store.js';
import type { PrincipalMailboxRecord } from '../../../../src/principal-mailboxes/types.js';

const logger = pino({ level: 'silent' });

function fakeClient(grant: string): NylasClient {
  return { grant } as unknown as NylasClient;
}

const REC: PrincipalMailboxRecord = {
  id: 'work', label: 'Work', address: 'pat@work.example.com', provider: 'google',
  isDefault: true, triageStartAt: null, removedAt: null, addedIdentityId: null,
};

function services(opts: {
  records?: PrincipalMailboxRecord[];
  secret?: (name: string) => Promise<string | null>;
  apiKey?: string | undefined;
  log?: typeof logger;
}) {
  const records = opts.records ?? [REC];
  const store = {
    listLive: async () => records,
    hasAnyRow: async () => records.length > 0,
    getAny: async (id: string) => records.find((r) => r.id === id) ?? null,
  } as unknown as PrincipalMailboxStore;
  return new PrincipalMailboxes({
    store,
    secrets: { get: opts.secret ?? (async () => 'grant-1') },
    apiKey: () => ('apiKey' in opts ? opts.apiKey : 'key'),
    logger: opts.log ?? logger,
  });
}

describe('createPrincipalMailboxResolver', () => {
  it("resolver uses the named mailbox's grant from the registry", async () => {
    const createClient = vi.fn((_k: string, g: string) => fakeClient(g));
    const get = vi.fn(async (n: string) => (n === 'principal.mailbox.work.nylas_grant_id' ? 'grant-w' : null));
    const resolve = createPrincipalMailboxResolver({
      mailboxes: services({ secret: get }),
      logger,
      createClient,
    });
    expect(await resolve('work')).toEqual({ grant: 'grant-w' });
    expect(createClient).toHaveBeenCalledWith('key', 'grant-w');
  });

  it('resolver returns null when no mailbox exists', async () => {
    const createClient = vi.fn();
    const resolve = createPrincipalMailboxResolver({
      mailboxes: services({ records: [] }),
      logger,
      createClient,
    });
    expect(await resolve('work')).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('an id that is not a live mailbox is null, never the default mailbox (#2475)', async () => {
    const createClient = vi.fn();
    const resolve = createPrincipalMailboxResolver({ mailboxes: services({}), logger: { ...logger, error: vi.fn() } as unknown as typeof logger, createClient });
    expect(await resolve('personal')).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns null when the mailbox has no grant in the vault', async () => {
    const createClient = vi.fn();
    const resolve = createPrincipalMailboxResolver({
      mailboxes: services({ secret: async () => null }),
      logger,
      createClient,
    });
    expect(await resolve('work')).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns null and warns naming the API key secret when it is missing', async () => {
    const createClient = vi.fn();
    const errorSpy = vi.fn();
    const warnSpy = vi.fn();
    const log = { ...logger, error: errorSpy, warn: warnSpy } as unknown as typeof logger;
    const resolve = createPrincipalMailboxResolver({
      mailboxes: services({ apiKey: undefined }),
      logger: log,
      createClient,
    });
    expect(await resolve('work')).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]!.at(-1))).toMatch(/channel\.email\.nylas_api_key/);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('grant-1');
  });

  it('returns null and warns, without the value, when the grant is blank (silent-failure 14)', async () => {
    const warnSpy = vi.fn();
    const log = { ...logger, warn: warnSpy } as unknown as typeof logger;
    const mailboxes = { defaultMailbox: async () => ({ id: 'work', label: 'Work', address: '', isDefault: true, triageStartAt: null }), credentials: async () => ({ apiKey: 'key', grantId: '   ' }) };
    const resolve = createPrincipalMailboxResolver({ mailboxes, logger: log, createClient: vi.fn() });
    expect(await resolve('work')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith({ hasGrant: false, hasApiKey: true }, expect.stringContaining('blank'));
  });

  it('returns null and logs an error when the secret read throws', async () => {
    const errorSpy = vi.fn();
    const log = { ...logger, error: errorSpy } as unknown as typeof logger;
    const resolve = createPrincipalMailboxResolver({
      mailboxes: services({ secret: async () => { throw new Error('decrypt failed'); } }),
      logger: log,
      createClient: vi.fn(),
    });
    expect(await resolve('work')).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('reuses the client while the grant is unchanged', async () => {
    const createClient = vi.fn((_k: string, g: string) => fakeClient(g));
    const resolve = createPrincipalMailboxResolver({
      mailboxes: services({}),
      logger,
      createClient,
    });
    const a = await resolve('work');
    const b = await resolve('work');
    expect(a).toBe(b);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('builds a new client when the grant changes', async () => {
    let grant = 'grant-1';
    const createClient = vi.fn((_k: string, g: string) => fakeClient(g));
    const resolve = createPrincipalMailboxResolver({
      mailboxes: services({ secret: async () => grant }),
      logger,
      createClient,
    });
    const a = await resolve('work');
    grant = 'grant-2';
    const b = await resolve('work');
    expect(a).not.toBe(b);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenLastCalledWith('key', 'grant-2');
  });
});
