import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { PrincipalMailboxes } from '../../../src/principal-mailboxes/service.js';
import type { PrincipalMailboxStore } from '../../../src/principal-mailboxes/store.js';
import {
  MissingNylasApiKeyError,
  RemovedMailboxError,
  UnknownMailboxError,
  type PrincipalMailboxRecord,
} from '../../../src/principal-mailboxes/types.js';
import {
  isPrincipalMailboxGrantKey,
  principalMailboxGrantSecretName,
} from '../../../src/principal-mailboxes/secrets.js';

const logger = pino({ level: 'silent' });

function rec(over: Partial<PrincipalMailboxRecord> = {}): PrincipalMailboxRecord {
  return {
    id: 'work',
    label: 'Work',
    address: 'pat@work.example.com',
    provider: 'google',
    isDefault: true,
    triageStartAt: null,
    removedAt: null,
    addedIdentityId: null,
    ...over,
  };
}

function build(records: PrincipalMailboxRecord[], secrets: Record<string, string> = {}, apiKey: string | null = 'api-key') {
  const store = {
    listLive: vi.fn(async () => records.filter((r) => r.removedAt === null)),
    hasAnyRow: vi.fn(async () => records.length > 0),
    getAny: vi.fn(async (id: string) => records.find((r) => r.id === id) ?? null),
  } as unknown as PrincipalMailboxStore;
  const get = vi.fn(async (n: string) => secrets[n] ?? null);
  const svc = new PrincipalMailboxes({ store, secrets: { get }, apiKey: () => apiKey ?? undefined, logger });
  return { svc, get, secrets };
}

describe('secrets helpers', () => {
  it('names and recognises per-mailbox grant keys', () => {
    expect(principalMailboxGrantSecretName('work')).toBe('principal.mailbox.work.nylas_grant_id');
    expect(isPrincipalMailboxGrantKey('principal.mailbox.work.nylas_grant_id')).toBe(true);
    expect(isPrincipalMailboxGrantKey('principal.mailbox.Work.nylas_grant_id')).toBe(false);
    expect(isPrincipalMailboxGrantKey('channel.email.nylas_api_key')).toBe(false);
  });
});

describe('PrincipalMailboxes', () => {
  it('get throws UnknownMailboxError for an unknown id', async () => {
    const { svc } = build([rec()]);
    await expect(svc.get('nope')).rejects.toBeInstanceOf(UnknownMailboxError);
  });

  it('get throws RemovedMailboxError for a removed id', async () => {
    const { svc } = build([rec({ id: 'old', isDefault: false, removedAt: new Date() }), rec()]);
    await expect(svc.get('old')).rejects.toBeInstanceOf(RemovedMailboxError);
  });

  it('list returns live mailboxes as views and addresses() their addresses', async () => {
    const { svc } = build([rec(), rec({ id: 'home', label: 'Home', address: 'pat@home.example.org', isDefault: false })]);
    expect((await svc.list()).map((v) => v.id)).toEqual(['work', 'home']);
    expect(await svc.addresses()).toEqual(['pat@work.example.com', 'pat@home.example.org']);
    expect((await svc.defaultMailbox())?.id).toBe('work');
  });

  it('principalEmailAddresses unions mailbox addresses with identity addresses, lowercase and deduplicated', async () => {
    const store = {
      listLive: vi.fn(async () => [rec(), rec({ id: 'home', address: 'Pat@Home.example.org', isDefault: false })]),
      hasAnyRow: vi.fn(async () => true),
    } as unknown as PrincipalMailboxStore;
    const svc = new PrincipalMailboxes({
      store,
      secrets: { get: async () => null },
      apiKey: () => 'k',
      logger,
      principalEmailIdentities: async () => ['PAT@work.example.com', 'pat@other.example.net', ''],
    });
    expect(await svc.principalEmailAddresses()).toEqual([
      'pat@work.example.com', 'pat@home.example.org', 'pat@other.example.net',
    ]);
  });

  it('principalEmailAddresses omits the fallback mailbox empty address and works without an identity source', async () => {
    const { svc } = build([]);
    svc.setFallback({ id: 'work', grantId: 'g' });
    expect(await svc.principalEmailAddresses()).toEqual([]);
  });

  it('credentials reads principal.mailbox.<id>.nylas_grant_id on every call', async () => {
    const { svc, get, secrets } = build([rec()], { 'principal.mailbox.work.nylas_grant_id': 'g1' });
    expect(await svc.credentials('work')).toEqual({ apiKey: 'api-key', grantId: 'g1' });
    secrets['principal.mailbox.work.nylas_grant_id'] = 'g2';
    expect(await svc.credentials('work')).toEqual({ apiKey: 'api-key', grantId: 'g2' });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith('principal.mailbox.work.nylas_grant_id');
  });

  it("credentials never falls back to the default mailbox's grant", async () => {
    const { svc } = build(
      [rec(), rec({ id: 'home', label: 'Home', isDefault: false })],
      { 'principal.mailbox.work.nylas_grant_id': 'g1' },
    );
    await expect(svc.credentials('home')).rejects.toThrow(/home/);
  });

  it('credentials throws when the API key is missing', async () => {
    const { svc } = build([rec()], { 'principal.mailbox.work.nylas_grant_id': 'g1' }, null);
    await expect(svc.credentials('work')).rejects.toBeInstanceOf(MissingNylasApiKeyError);
  });

  it('list returns the fallback when the table is empty and a fallback is set', async () => {
    const { svc } = build([], { ceo_nylas_grant_id: 'fb-grant' });
    expect(await svc.list()).toEqual([]);
    expect(await svc.defaultMailbox()).toBeNull();
    svc.setFallback({ id: 'mailbox', grantId: 'fb-grant' });
    expect(await svc.list()).toEqual([
      { id: 'mailbox', label: 'Mailbox', address: '', isDefault: true, triageStartAt: null },
    ]);
    expect((await svc.defaultMailbox())?.id).toBe('mailbox');
    expect(await svc.get('mailbox')).toMatchObject({ id: 'mailbox' });
    expect(await svc.credentials('mailbox')).toEqual({ apiKey: 'api-key', grantId: 'fb-grant' });
    expect(await svc.addresses()).toEqual([]);
    svc.setFallback(null);
    expect(await svc.list()).toEqual([]);
  });

  it('the fallback reads the flat grant on every call, so a vault change applies at once', async () => {
    const { svc, secrets } = build([], { ceo_nylas_grant_id: 'boot-grant' });
    svc.setFallback({ id: 'mailbox', grantId: 'boot-grant' });
    secrets['ceo_nylas_grant_id'] = 'new-grant';
    expect(await svc.credentials('mailbox')).toEqual({ apiKey: 'api-key', grantId: 'new-grant' });
    delete secrets['ceo_nylas_grant_id'];
    await expect(svc.credentials('mailbox')).rejects.toThrow('no Nylas grant configured');
  });

  it('list ignores the fallback once the table has rows', async () => {
    const { svc } = build([rec()], { 'principal.mailbox.work.nylas_grant_id': 'g1' });
    svc.setFallback({ id: 'mailbox', grantId: 'fb-grant' });
    expect((await svc.list()).map((v) => v.id)).toEqual(['work']);
    await expect(svc.get('other')).rejects.toBeInstanceOf(UnknownMailboxError);
  });

  it('the fallback id is unknown when a live row exists', async () => {
    const { svc } = build([rec()], { 'principal.mailbox.work.nylas_grant_id': 'g1' });
    svc.setFallback({ id: 'mailbox', grantId: 'fb' });
    await expect(svc.get('mailbox')).rejects.toBeInstanceOf(UnknownMailboxError);
    await expect(svc.credentials('mailbox')).rejects.toBeInstanceOf(UnknownMailboxError);
  });

  it('the fallback is not served when only removed rows exist', async () => {
    const { svc } = build([rec({ removedAt: new Date(), isDefault: false })]);
    svc.setFallback({ id: 'mailbox', grantId: 'fb' });
    expect(await svc.list()).toEqual([]);
    expect(await svc.defaultMailbox()).toBeNull();
    await expect(svc.get('mailbox')).rejects.toBeInstanceOf(UnknownMailboxError);
    await expect(svc.credentials('mailbox')).rejects.toBeInstanceOf(UnknownMailboxError);
  });

  it('a registry row whose id equals the fallback id wins over the fallback', async () => {
    const { svc } = build([rec({ id: 'mailbox', label: 'Real' })], { 'principal.mailbox.mailbox.nylas_grant_id': 'real-g' });
    svc.setFallback({ id: 'mailbox', grantId: 'fb' });
    expect((await svc.get('mailbox')).label).toBe('Real');
    expect(await svc.credentials('mailbox')).toEqual({ apiKey: 'api-key', grantId: 'real-g' });
  });

  it('credentials throws RemovedMailboxError for a removed id', async () => {
    const { svc } = build([rec({ removedAt: new Date(), isDefault: false })]);
    await expect(svc.credentials('work')).rejects.toBeInstanceOf(RemovedMailboxError);
  });

  it('credentials throws UnknownMailboxError for an unknown id with no fallback', async () => {
    const { svc } = build([rec()]);
    await expect(svc.credentials('nope')).rejects.toBeInstanceOf(UnknownMailboxError);
  });

  it('gatewayClient and calendarClient build per call from current credentials', async () => {
    const store = { listLive: async () => [rec()], hasAnyRow: async () => true, getAny: async () => rec() } as unknown as PrincipalMailboxStore;
    const createNylasClient = vi.fn(() => ({ kind: 'mail' }) as never);
    const createCalendarClient = vi.fn(() => ({ kind: 'cal' }) as never);
    const svc = new PrincipalMailboxes({
      store,
      secrets: { get: async () => 'g1' },
      apiKey: () => 'k',
      logger,
      createNylasClient,
      createCalendarClient,
    });
    await svc.gatewayClient('work');
    await svc.gatewayClient('work');
    await svc.calendarClient('work');
    expect(createNylasClient).toHaveBeenCalledTimes(2);
    expect(createNylasClient).toHaveBeenCalledWith('k', 'g1');
    expect(createCalendarClient).toHaveBeenCalledWith('k', 'g1');
  });

  it('ceoClient builds a ready client without returning the key, and forSkills has no credentials', async () => {
    const { svc } = build([rec()], { [principalMailboxGrantSecretName('work')]: 'g1' });
    const client = await svc.ceoClient('work', logger);
    expect(client).toBeDefined();
    const view = svc.forSkills();
    expect(view).not.toHaveProperty('credentials');
    expect(view).not.toHaveProperty('calendarClient');
    expect((await view.list()).map((m) => m.id)).toEqual(['work']);
    expect(await view.ceoClient('work', logger)).toBeDefined();
    await expect(view.ceoClient('nope', logger)).rejects.toBeInstanceOf(UnknownMailboxError);
  });

  it('forCalendarRouter holds closures only: no credentials, no instance (#2475, F7)', async () => {
    const { svc } = build([rec()], { [principalMailboxGrantSecretName('work')]: 'g1' });
    const view = svc.forCalendarRouter();
    expect(Object.keys(view).sort()).toEqual(['calendarClient', 'get', 'isFallbackActive', 'list']);
    expect(view).not.toHaveProperty('credentials');
    expect((await view.list()).map((m) => m.id)).toEqual(['work']);
    await expect(view.calendarClient('nope')).rejects.toBeInstanceOf(UnknownMailboxError);
  });
});
