import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { MIRROR_PENDING_WARNING, PrincipalMailboxAdmin } from '../../../src/principal-mailboxes/admin.js';
import type { PrincipalMailboxStore } from '../../../src/principal-mailboxes/store.js';
import { RemovedMailboxError, type PrincipalMailboxRecord } from '../../../src/principal-mailboxes/types.js';
import { principalMailboxGrantSecretName } from '../../../src/principal-mailboxes/secrets.js';
import { dropLegacyDefaultKey } from '../../../src/principal-mailboxes/migrate-config-keys.js';
import { createSendLevelReader } from '../../../src/skills/principal-send/send-level.js';
import { ContactService } from '../../../src/contacts/contact-service.js';

const logger = pino({ level: 'silent' });
const PRINCIPAL = 'principal-contact';

interface Identity { id: string; channel: string; channelIdentifier: string; verified: boolean; status: string }

function setup(opts: {
  records?: PrincipalMailboxRecord[];
  identities?: Identity[];
  primaryEmail?: string | null;
  secrets?: Record<string, string>;
  grants?: Record<string, { email: string; provider: string }>;
  curia?: string[];
  maxLiveMailboxes?: number;
  otherContacts?: Record<string, string>;
  insertFails?: boolean;
  onRemoved?: Array<(id: string) => Promise<void>>;
  forgetLegacySendLevel?: () => Promise<void>;
  isFallbackActive?: () => Promise<boolean>;
  logger?: pino.Logger;
  reconcileFlatKeys?: () => Promise<unknown>;
  curiaGrants?: string[];
} = {}) {
  const records: PrincipalMailboxRecord[] = [...(opts.records ?? [])];
  const identities: Identity[] = [...(opts.identities ?? [])];
  const secrets: Record<string, string> = { ...(opts.secrets ?? {}) };
  const contact = { primaryEmail: opts.primaryEmail ?? null };
  let nextIdentity = 1;

  const store = {
    listLive: vi.fn(async () => records.filter((r) => !r.removedAt)),
    getAny: vi.fn(async (id: string) => records.find((r) => r.id === id) ?? null),
    insert: vi.fn(async (r: Omit<PrincipalMailboxRecord, 'removedAt'>) => {
      if (opts.insertFails) throw new Error('insert failed');
      if (r.isDefault) for (const x of records) if (!x.removedAt) x.isDefault = false;
      records.push({ ...r, removedAt: null });
    }),
    setDefault: vi.fn(async (id: string) => {
      for (const r of records) if (!r.removedAt) r.isDefault = r.id === id;
    }),
    tombstone: vi.fn(async (id: string, newDefaultId: string | null) => {
      const r = records.find((x) => x.id === id)!;
      r.removedAt = new Date();
      r.isDefault = false;
      if (newDefaultId) records.find((x) => x.id === newDefaultId)!.isDefault = true;
    }),
  } as unknown as PrincipalMailboxStore;

  const contacts = {
    linkIdentity: vi.fn(async (o: { channelIdentifier: string; channel: string }) => {
      const id = `ident-${nextIdentity++}`;
      identities.push({ id, channel: o.channel, channelIdentifier: o.channelIdentifier, verified: true, status: 'active' });
      return { id };
    }),
    unlinkIdentity: vi.fn(async (id: string) => {
      const i = identities.findIndex((x) => x.id === id);
      if (i >= 0) identities.splice(i, 1);
      return i >= 0;
    }),
    getContactWithIdentities: vi.fn(async () => ({ contact, identities })),
    verifyIdentity: vi.fn(async (id: string) => { identities.find((i) => i.id === id)!.verified = true; return {}; }),
    setIdentityStatus: vi.fn(async (id: string, st: string) => { identities.find((i) => i.id === id)!.status = st; return {}; }),
    resolveByChannelIdentity: vi.fn(async (_c: string, addr: string) => {
      const o = opts.otherContacts?.[addr];
      return o ? { contactId: o } : null;
    }),
    updateContactFields: vi.fn(async (_id: string, f: { primaryEmail?: string }) => {
      if (f.primaryEmail) contact.primaryEmail = f.primaryEmail;
      return contact;
    }),
  };
  const secretStore = {
    get: vi.fn(async (n: string) => secrets[n] ?? null),
    set: vi.fn(async (n: string, v: string) => { secrets[n] = v; }),
    delete: vi.fn(async (n: string) => { delete secrets[n]; }),
  };
  const grants = opts.grants ?? {};
  const admin = new PrincipalMailboxAdmin({
    store,
    secrets: secretStore,
    contacts: contacts as never,
    principalContactId: PRINCIPAL,
    curiaAccountAddresses: async () => opts.curia ?? [],
    lookupGrant: vi.fn(async (g: string) => {
      const found = grants[g];
      if (!found) throw new Error('unreadable');
      return found;
    }),
    onRemoved: opts.onRemoved,
    forgetLegacySendLevel: opts.forgetLegacySendLevel,
    isFallbackActive: opts.isFallbackActive,
    reconcileFlatKeys: opts.reconcileFlatKeys,
    ...(opts.curiaGrants ? { curiaAccountGrantIds: async () => opts.curiaGrants! } : {}),
    logger: opts.logger ?? logger,
    maxLiveMailboxes: opts.maxLiveMailboxes,
  });
  return { admin, store, contacts, secretStore, records, identities, secrets, contact };
}

const rec = (over: Partial<PrincipalMailboxRecord> = {}): PrincipalMailboxRecord => ({
  id: 'personal', label: 'Personal', address: 'pat@gmail.com', provider: 'google',
  isDefault: true, triageStartAt: null, removedAt: null, addedIdentityId: null, ...over,
});
const google = (email: string) => ({ email, provider: 'google' });

describe('PrincipalMailboxAdmin.add', () => {
  it("refuses a grant that is one of Curia's own email accounts (F6)", async () => {
    const { admin, secretStore } = setup({ grants: { 'curia-grant-1': google('pat@gmail.com') }, curiaGrants: ['curia-grant-1'] });
    expect(await admin.add({ id: 'personal', label: 'Personal', grantId: 'curia-grant-1' })).toMatchObject({ ok: false, refusal: 'curia_account_address' });
    expect(secretStore.set).not.toHaveBeenCalled();
  });

  it('undoing a failed add deletes the grant even when unlinking the identity fails (silent-failure 12)', async () => {
    const s = setup({ grants: { g: google('pat@gmail.com') }, insertFails: true });
    s.contacts.unlinkIdentity.mockRejectedValueOnce(new Error('contacts down'));
    await expect(s.admin.add({ id: 'personal', label: 'Personal', grantId: 'g' })).rejects.toThrow('insert failed');
    expect(s.secretStore.delete).toHaveBeenCalledWith(principalMailboxGrantSecretName('personal'));
  });

  it('refuses bad and reserved ids', async () => {
    const { admin } = setup();
    for (const id of ['Work', '1x', 'primary', 'default', '']) {
      const r = await admin.add({ id, label: 'x', grantId: 'g' });
      expect(r).toMatchObject({ ok: false, refusal: 'bad_id' });
    }
  });

  it('refuses an id already taken, live or removed', async () => {
    const { admin } = setup({ records: [rec({ id: 'gone', isDefault: false, removedAt: new Date() })], grants: { g: google('a@gmail.com') } });
    expect(await admin.add({ id: 'gone', label: 'x', grantId: 'g' })).toMatchObject({ refusal: 'id_taken' });
  });

  it('refuses when the live cap is reached', async () => {
    const { admin } = setup({ records: [rec()], grants: { g: google('a@gmail.com') } });
    expect(await admin.add({ id: 'work', label: 'Work', grantId: 'g' })).toMatchObject({ refusal: 'cap_reached' });
  });

  it('refuses a grant that cannot be read', async () => {
    const { admin } = setup();
    expect(await admin.add({ id: 'work', label: 'Work', grantId: 'nope' })).toMatchObject({ refusal: 'grant_unreadable' });
  });

  it('refuses a non-google grant', async () => {
    const { admin } = setup({ grants: { g: { email: 'a@example.org', provider: 'microsoft' } } });
    expect(await admin.add({ id: 'work', label: 'Work', grantId: 'g' })).toMatchObject({ refusal: 'not_google' });
  });

  it('refuses a grant id already stored for a live mailbox', async () => {
    const { admin } = setup({
      records: [rec()], maxLiveMailboxes: 5,
      secrets: { [principalMailboxGrantSecretName('personal')]: 'g' },
      grants: { g: google('other@gmail.com') },
    });
    expect(await admin.add({ id: 'work', label: 'Work', grantId: 'g' })).toMatchObject({ refusal: 'grant_in_use' });
  });

  it('refuses an address that is already a live mailbox', async () => {
    const { admin } = setup({ records: [rec()], maxLiveMailboxes: 5, grants: { g2: google('PAT@gmail.com') } });
    expect(await admin.add({ id: 'work', label: 'Work', grantId: 'g2' })).toMatchObject({ refusal: 'address_in_use' });
  });

  it("refuses one of Curia's own account addresses", async () => {
    const { admin } = setup({ curia: ['curia@example.com'], grants: { g: google('Curia@example.com') } });
    expect(await admin.add({ id: 'work', label: 'Work', grantId: 'g' })).toMatchObject({ refusal: 'curia_account_address' });
  });

  it('links a verified identity and records it', async () => {
    const { admin, contacts, records, secrets } = setup({ grants: { g: google('pat@work.example.com') } });
    const r = await admin.add({ id: 'work', label: 'Work', grantId: 'g' });
    expect(r).toMatchObject({ ok: true, mailbox: { id: 'work', address: 'pat@work.example.com', isDefault: true } });
    expect(contacts.linkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      contactId: PRINCIPAL, channel: 'email', channelIdentifier: 'pat@work.example.com', source: 'ceo_stated', verified: true,
    }));
    expect(records[0]!.addedIdentityId).toBe('ident-1');
    expect(records[0]!.triageStartAt).toBeInstanceOf(Date);
    expect(secrets[principalMailboxGrantSecretName('work')]).toBe('g');
  });

  it('does not relink an existing verified active identity', async () => {
    const { admin, contacts, records } = setup({
      identities: [{ id: 'old', channel: 'email', channelIdentifier: 'Pat@Work.example.com', verified: true, status: 'active' }],
      grants: { g: google('pat@work.example.com') },
    });
    await admin.add({ id: 'work', label: 'Work', grantId: 'g' });
    expect(contacts.linkIdentity).not.toHaveBeenCalled();
    expect(contacts.verifyIdentity).not.toHaveBeenCalled();
    expect(contacts.setIdentityStatus).not.toHaveBeenCalled();
    expect(records[0]!.addedIdentityId).toBeNull();
  });

  it('verifies and reactivates an existing principal identity without recording it as added', async () => {
    const { admin, contacts, records, identities } = setup({
      identities: [{ id: 'old', channel: 'email', channelIdentifier: 'pat@work.example.com', verified: false, status: 'defunct' }],
      grants: { g: google('pat@work.example.com') },
    });
    await admin.add({ id: 'work', label: 'Work', grantId: 'g' });
    expect(contacts.verifyIdentity).toHaveBeenCalledWith('old');
    expect(contacts.setIdentityStatus).toHaveBeenCalledWith('old', 'active');
    expect(contacts.linkIdentity).not.toHaveBeenCalled();
    expect(identities[0]).toMatchObject({ verified: true, status: 'active' });
    expect(records[0]!.addedIdentityId).toBeNull();
  });

  it('refuses an address that belongs to another contact, before any write', async () => {
    const { admin, secretStore, store, contacts } = setup({
      grants: { g: google('pat@work.example.com') },
      otherContacts: { 'pat@work.example.com': 'someone-else' },
    });
    expect(await admin.add({ id: 'work', label: 'Work', grantId: 'g' })).toMatchObject({ refusal: 'address_is_another_contact' });
    expect(secretStore.set).not.toHaveBeenCalled();
    expect(contacts.linkIdentity).not.toHaveBeenCalled();
    expect(store.insert).not.toHaveBeenCalled();
  });

  it('a failed insert leaves no row, secret or identity', async () => {
    const { admin, records, secrets, identities } = setup({ insertFails: true, grants: { g: google('pat@work.example.com') } });
    await expect(admin.add({ id: 'work', label: 'Work', grantId: 'g' })).rejects.toThrow('insert failed');
    expect(records).toHaveLength(0);
    expect(secrets).toEqual({});
    expect(identities).toHaveLength(0);
  });

  it('never changes primary_email', async () => {
    const { admin, contacts, contact } = setup({ primaryEmail: 'pat@gmail.com', grants: { g: google('pat@work.example.com') } });
    await admin.add({ id: 'work', label: 'Work', grantId: 'g' });
    expect(contacts.updateContactFields).not.toHaveBeenCalled();
    expect(contact.primaryEmail).toBe('pat@gmail.com');
  });

  it('makeDefault moves the default to the new mailbox', async () => {
    const { admin, records } = setup({ records: [rec()], maxLiveMailboxes: 5, grants: { g: google('pat@work.example.com') } });
    await admin.add({ id: 'work', label: 'Work', grantId: 'g', makeDefault: true });
    expect(records.find((r) => r.id === 'work')!.isDefault).toBe(true);
    expect(records.find((r) => r.id === 'personal')!.isDefault).toBe(false);
  });

  it('a second mailbox is not default unless asked', async () => {
    const { admin, records } = setup({ records: [rec()], maxLiveMailboxes: 5, grants: { g: google('pat@work.example.com') } });
    await admin.add({ id: 'work', label: 'Work', grantId: 'g' });
    expect(records.find((r) => r.id === 'work')!.isDefault).toBe(false);
  });

  it('ids are never reused', async () => {
    const { admin } = setup({ grants: { g: google('pat@work.example.com') } });
    await admin.add({ id: 'work', label: 'Work', grantId: 'g' });
    await admin.remove({ id: 'work', stillOwned: true });
    expect(await admin.add({ id: 'work', label: 'Work', grantId: 'g' })).toMatchObject({ refusal: 'id_taken' });
  });
});

describe('PrincipalMailboxAdmin.remove', () => {
  const two = () => [
    rec(),
    rec({ id: 'work', label: 'Work', address: 'pat@work.example.com', isDefault: false, addedIdentityId: 'ident-w' }),
  ];

  it('removal of the default requires a new default', async () => {
    const { admin, store } = setup({ records: two(), secrets: { [principalMailboxGrantSecretName('work')]: 'g-work' } });
    await expect(admin.remove({ id: 'personal', stillOwned: true })).rejects.toThrow(/new default/);
    expect(store.tombstone).not.toHaveBeenCalled();
    await admin.remove({ id: 'personal', stillOwned: true, newDefaultId: 'work' });
    expect(store.tombstone).toHaveBeenCalledWith('personal', 'work');
  });

  it('rejects a replacement default that is not another live mailbox', async () => {
    const { admin } = setup({ records: two() });
    await expect(admin.remove({ id: 'personal', stillOwned: true, newDefaultId: 'personal' })).rejects.toThrow();
    await expect(admin.remove({ id: 'personal', stillOwned: true, newDefaultId: 'nope' })).rejects.toThrow();
  });

  it('requires a new primary email when the address is primary', async () => {
    const { admin, contacts, store } = setup({ records: two(), primaryEmail: 'Pat@Gmail.com', secrets: { [principalMailboxGrantSecretName('work')]: 'g-work' } });
    await expect(admin.remove({ id: 'personal', stillOwned: true, newDefaultId: 'work' })).rejects.toThrow(/primary email/);
    expect(store.tombstone).not.toHaveBeenCalled();
    await expect(
      admin.remove({ id: 'personal', stillOwned: true, newDefaultId: 'work', newPrimaryEmail: 'stranger@example.org' }),
    ).rejects.toThrow(/primary email/);
    await admin.remove({ id: 'personal', stillOwned: true, newDefaultId: 'work', newPrimaryEmail: 'pat@work.example.com' });
    expect(contacts.updateContactFields).toHaveBeenCalledWith(PRINCIPAL, { primaryEmail: 'pat@work.example.com' });
    expect(store.tombstone).toHaveBeenCalled();
  });

  it('restores the primary email when the tombstone fails, so a failed removal changes nothing', async () => {
    const { admin, contacts, store, contact, records } = setup({ records: two(), primaryEmail: 'pat@gmail.com', secrets: { [principalMailboxGrantSecretName('work')]: 'g-work' } });
    vi.mocked(store.tombstone).mockRejectedValueOnce(new Error('db down'));
    await expect(
      admin.remove({ id: 'personal', stillOwned: true, newDefaultId: 'work', newPrimaryEmail: 'pat@work.example.com' }),
    ).rejects.toThrow('db down');
    expect(contacts.updateContactFields).toHaveBeenLastCalledWith(PRINCIPAL, { primaryEmail: 'pat@gmail.com' });
    expect(contact.primaryEmail).toBe('pat@gmail.com');
    expect(records.find((r) => r.id === 'personal')!.removedAt).toBeNull();
  });

  it('does not restore the primary email when another removal of the mailbox already completed', async () => {
    const { admin, contacts, store } = setup({ records: two(), primaryEmail: 'pat@gmail.com', secrets: { [principalMailboxGrantSecretName('work')]: 'g-work' } });
    vi.mocked(store.tombstone).mockRejectedValueOnce(new RemovedMailboxError('personal', 'Personal'));
    await expect(
      admin.remove({ id: 'personal', stillOwned: true, newDefaultId: 'work', newPrimaryEmail: 'pat@work.example.com' }),
    ).rejects.toBeInstanceOf(RemovedMailboxError);
    expect(contacts.updateContactFields).toHaveBeenCalledTimes(1);
    expect(contacts.updateContactFields).toHaveBeenCalledWith(PRINCIPAL, { primaryEmail: 'pat@work.example.com' });
  });

  it('stillOwned=false unlinks only the identity it added', async () => {
    const { admin, contacts } = setup({ records: two(), secrets: { [principalMailboxGrantSecretName('work')]: 'g' } });
    await admin.remove({ id: 'work', stillOwned: false });
    expect(contacts.unlinkIdentity).toHaveBeenCalledWith('ident-w');
  });

  it('never unlinks a pre-existing identity', async () => {
    const { admin, contacts } = setup({ records: two() });
    await admin.remove({ id: 'work', stillOwned: false }).catch(() => undefined);
    const r = setup({ records: [rec()] });
    await r.admin.remove({ id: 'personal', stillOwned: false });
    expect(r.contacts.unlinkIdentity).not.toHaveBeenCalled();
    expect(contacts.unlinkIdentity).toHaveBeenCalledTimes(1);
  });

  it('stillOwned=true keeps the identity', async () => {
    const { admin, contacts } = setup({ records: two() });
    await admin.remove({ id: 'work', stillOwned: true });
    expect(contacts.unlinkIdentity).not.toHaveBeenCalled();
  });

  it('deletes the grant secret and runs hooks after the tombstone', async () => {
    const order: string[] = [];
    const hook = vi.fn(async () => { order.push('hook'); });
    const s = setup({ records: two(), secrets: { [principalMailboxGrantSecretName('work')]: 'g' }, onRemoved: [hook] });
    vi.mocked(s.store.tombstone).mockImplementationOnce(async () => { order.push('tombstone'); });
    s.secretStore.delete.mockImplementationOnce(async () => { order.push('secret'); });
    await s.admin.remove({ id: 'work', stillOwned: true });
    expect(order).toEqual(['tombstone', 'secret', 'hook']);
    expect(hook).toHaveBeenCalledWith('work');
  });

  it('past the tombstone, a failed step is reported and the remaining steps still run', async () => {
    const hook = vi.fn(async () => {});
    const s = setup({ records: two(), onRemoved: [hook] });
    s.secretStore.delete.mockRejectedValueOnce(new Error('vault down'));
    const out = await s.admin.remove({ id: 'work', stillOwned: false });
    expect(out).toEqual({ cleanupIncomplete: ['grant_secret'], restartRequired: false });
    expect(s.store.tombstone).toHaveBeenCalled();
    expect(s.contacts.unlinkIdentity).toHaveBeenCalledWith('ident-w');
    expect(hook).toHaveBeenCalledWith('work');
  });

  it('clears the flat keys before the identity work, and reconciles them after every removal (F3)', async () => {
    const order: string[] = [];
    const reconcile = vi.fn(async () => { order.push('reconcile'); });
    const s = setup({ records: [rec({ addedIdentityId: 'ident-p' })], secrets: { ceo_nylas_grant_id: 'g', ceo_self_email: 'pat@gmail.com' }, reconcileFlatKeys: reconcile });
    const realDelete = s.secretStore.delete.getMockImplementation()!;
    s.secretStore.delete.mockImplementation(async (n: string) => { order.push(`delete:${n}`); await realDelete(n); });
    s.contacts.unlinkIdentity.mockImplementation(async () => { order.push('unlink'); return true; });
    const out = await s.admin.remove({ id: 'personal', stillOwned: false });
    expect(order).toEqual([
      `delete:${principalMailboxGrantSecretName('personal')}`, 'delete:ceo_nylas_grant_id', 'delete:ceo_self_email', 'unlink', 'reconcile',
    ]);
    expect(out).toEqual({ cleanupIncomplete: [], restartRequired: true });
  });

  it('a failed flat-key step that the reconcile repairs is not reported', async () => {
    const s = setup({ records: [rec()], secrets: { ceo_nylas_grant_id: 'g' }, reconcileFlatKeys: vi.fn(async () => 'cleared') });
    const realDelete = s.secretStore.delete.getMockImplementation()!;
    s.secretStore.delete.mockImplementation(async (n: string) => {
      if (n === 'ceo_nylas_grant_id') throw new Error('vault blip');
      await realDelete(n);
    });
    expect(await s.admin.remove({ id: 'personal', stillOwned: true })).toEqual({ cleanupIncomplete: [], restartRequired: true });
  });

  it('refuses unknown and removed ids', async () => {
    const { admin } = setup({ records: [rec({ removedAt: new Date(), isDefault: false })] });
    await expect(admin.remove({ id: 'nope', stillOwned: true })).rejects.toThrow(/Unknown/);
    await expect(admin.remove({ id: 'personal', stillOwned: true })).rejects.toThrow(/removed/);
  });
});

describe('PrincipalMailboxAdmin.removalPreview', () => {
  it('describes the consequences', async () => {
    const { admin } = setup({
      records: [rec(), rec({ id: 'work', label: 'Work', address: 'pat@work.example.com', isDefault: false })],
      primaryEmail: 'pat@gmail.com',
    });
    const p = await admin.removalPreview('personal');
    expect(p).toMatchObject({ isDefault: true, isPrimaryEmail: true, stillOwnedDefault: true, scopedRules: [], calendars: [] });
    expect(p.otherLive.map((m) => m.id)).toEqual(['work']);
    const w = await admin.removalPreview('work');
    expect(w).toMatchObject({ isDefault: false, isPrimaryEmail: false, stillOwnedDefault: false });
  });
});

describe('PrincipalMailboxAdmin.removalPreview primaryEmailCandidates', () => {
  it('unions other live mailboxes with verified active email identities, minus the removed address', async () => {
    const { admin } = setup({
      records: [rec(), rec({ id: 'work', label: 'Work', address: 'Pat@Work.example.com', isDefault: false })],
      identities: [
        { id: 'i1', channel: 'email', channelIdentifier: 'pat@gmail.com', verified: true, status: 'active' },
        { id: 'i2', channel: 'email', channelIdentifier: 'pat@home.example.org', verified: true, status: 'active' },
        { id: 'i3', channel: 'email', channelIdentifier: 'unverified@example.org', verified: false, status: 'active' },
        { id: 'i4', channel: 'email', channelIdentifier: 'WORK@example.org', verified: true, status: 'inactive' },
        { id: 'i5', channel: 'email', channelIdentifier: 'PAT@Work.example.com', verified: true, status: 'active' },
      ],
      primaryEmail: 'pat@gmail.com',
    });
    const p = await admin.removalPreview('personal');
    expect([...p.primaryEmailCandidates].sort()).toEqual(['pat@home.example.org', 'pat@work.example.com']);
  });

  it('is empty when nothing else could be the primary', async () => {
    const { admin } = setup({ records: [rec()], primaryEmail: 'pat@gmail.com' });
    expect((await admin.removalPreview('personal')).primaryEmailCandidates).toEqual([]);
  });
});

describe('PrincipalMailboxAdmin.setDefault', () => {
  it('delegates to the store', async () => {
    const { admin, store } = setup({ records: [rec()], secrets: { [principalMailboxGrantSecretName('personal')]: 'g' } });
    await admin.setDefault('personal');
    expect(store.setDefault).toHaveBeenCalledWith('personal');
  });
});

// Capture every log line so a test can assert a grant id never reaches the logs (R20).
function capturingLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino({ level: 'debug' }, { write: (s: string) => { lines.push(s); } });
  return { logger, lines };
}

const FLAT_GRANT = 'ceo_nylas_grant_id';
const FLAT_EMAIL = 'ceo_self_email';

describe('PrincipalMailboxAdmin flat-key mirror (R28)', () => {
  it('mirrors a new default mailbox into the flat keys', async () => {
    const { admin, secrets } = setup({ grants: { g: google('Pat@Work.example.com') } });
    await admin.add({ id: 'work', label: 'Work', grantId: 'g' });
    expect(secrets[FLAT_GRANT]).toBe('g');
    expect(secrets[FLAT_EMAIL]).toBe('pat@work.example.com');
  });

  it('does not touch the flat keys for a non-default add', async () => {
    const { admin, secrets } = setup({
      records: [rec()], maxLiveMailboxes: 5,
      secrets: { [FLAT_GRANT]: 'g-personal', [FLAT_EMAIL]: 'pat@gmail.com' },
      grants: { g: google('pat@work.example.com') },
    });
    await admin.add({ id: 'work', label: 'Work', grantId: 'g' });
    expect(secrets[FLAT_GRANT]).toBe('g-personal');
    expect(secrets[FLAT_EMAIL]).toBe('pat@gmail.com');
  });

  it('setDefault mirrors the new default', async () => {
    const { admin, secrets } = setup({
      records: [rec(), rec({ id: 'work', label: 'Work', address: 'pat@work.example.com', isDefault: false })],
      secrets: {
        [FLAT_GRANT]: 'g-personal', [FLAT_EMAIL]: 'pat@gmail.com',
        [principalMailboxGrantSecretName('work')]: 'g-work',
      },
    });
    await admin.setDefault('work');
    expect(secrets[FLAT_GRANT]).toBe('g-work');
    expect(secrets[FLAT_EMAIL]).toBe('pat@work.example.com');
  });

  it('removing the default deletes both flat keys, after the per-mailbox secret and before hooks', async () => {
    const order: string[] = [];
    const hook = vi.fn(async () => { order.push('hook'); });
    const s = setup({
      records: [rec()],
      secrets: { [FLAT_GRANT]: 'g', [FLAT_EMAIL]: 'pat@gmail.com', [principalMailboxGrantSecretName('personal')]: 'g' },
      onRemoved: [hook],
    });
    const realDelete = s.secretStore.delete.getMockImplementation()!;
    s.secretStore.delete.mockImplementation(async (n: string) => { order.push(n); await realDelete(n); });
    await s.admin.remove({ id: 'personal', stillOwned: true });
    expect(s.secrets[FLAT_GRANT]).toBeUndefined();
    expect(s.secrets[FLAT_EMAIL]).toBeUndefined();
    expect(order).toEqual([principalMailboxGrantSecretName('personal'), FLAT_GRANT, FLAT_EMAIL, 'hook']);
  });

  it('removing the default with a new default mirrors the new default instead', async () => {
    const s = setup({
      records: [rec(), rec({ id: 'work', label: 'Work', address: 'pat@work.example.com', isDefault: false })],
      secrets: {
        [FLAT_GRANT]: 'g-personal', [FLAT_EMAIL]: 'pat@gmail.com',
        [principalMailboxGrantSecretName('personal')]: 'g-personal',
        [principalMailboxGrantSecretName('work')]: 'g-work',
      },
    });
    await s.admin.remove({ id: 'personal', stillOwned: true, newDefaultId: 'work' });
    expect(s.secrets[FLAT_GRANT]).toBe('g-work');
    expect(s.secrets[FLAT_EMAIL]).toBe('pat@work.example.com');
  });

  it('removing a non-default mailbox leaves the flat keys', async () => {
    const s = setup({
      records: [rec(), rec({ id: 'work', label: 'Work', address: 'pat@work.example.com', isDefault: false })],
      secrets: { [FLAT_GRANT]: 'g-personal', [FLAT_EMAIL]: 'pat@gmail.com' },
    });
    await s.admin.remove({ id: 'work', stillOwned: true });
    expect(s.secrets[FLAT_GRANT]).toBe('g-personal');
    expect(s.secrets[FLAT_EMAIL]).toBe('pat@gmail.com');
  });

  it('a mirror failure after the add committed is a success with a warning, logged without the grant id', async () => {
    const { logger: log, lines } = capturingLogger();
    const s = setup({ grants: { 'grant-secret-9': google('pat@work.example.com') }, logger: log });
    const realSet = s.secretStore.set.getMockImplementation()!;
    s.secretStore.set.mockImplementation(async (n: string, v: string) => {
      if (n === FLAT_GRANT) throw new Error('vault down');
      await realSet(n, v);
    });
    const r = await s.admin.add({ id: 'work', label: 'Work', grantId: 'grant-secret-9' });
    expect(r).toMatchObject({ ok: true, warning: MIRROR_PENDING_WARNING });
    expect(s.records).toHaveLength(1);
    expect(lines.join('')).toContain('vault down');
    expect(lines.join('')).not.toContain('grant-secret-9');
  });

  it('a mirror failure that the reconcile repairs at once needs no warning (setDefault, replaceGrant)', async () => {
    const reconcile = vi.fn(async () => 'mirrored');
    const s = setup({
      records: [rec(), rec({ id: 'work', label: 'Work', address: 'pat@work.example.com', isDefault: false })],
      secrets: { [principalMailboxGrantSecretName('personal')]: 'g-p', [principalMailboxGrantSecretName('work')]: 'g-w' },
      grants: { 'g-p2': google('pat@gmail.com') },
      reconcileFlatKeys: reconcile,
    });
    s.secretStore.set.mockImplementation(async (n: string) => { if (n === FLAT_GRANT) throw new Error('vault down'); });
    expect(await s.admin.setDefault('work')).toEqual({});
    expect(await s.admin.replaceGrant('work', 'g-p2')).toMatchObject({ ok: false }); // address mismatch
    reconcile.mockRejectedValueOnce(new Error('still down'));
    expect(await s.admin.setDefault('personal')).toEqual({ warning: MIRROR_PENDING_WARNING });
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});

describe('PrincipalMailboxAdmin.replaceGrant (R29)', () => {
  const two = () => [
    rec(),
    rec({ id: 'work', label: 'Work', address: 'pat@work.example.com', isDefault: false }),
  ];

  it('refuses unknown and removed ids', async () => {
    const { admin } = setup({ records: [rec({ id: 'old', removedAt: new Date(), isDefault: false })], grants: { g: google('pat@gmail.com') } });
    await expect(admin.replaceGrant('nope', 'g')).rejects.toThrow(/Unknown/);
    await expect(admin.replaceGrant('old', 'g')).rejects.toThrow(/removed/);
  });

  it('refuses an unreadable grant without logging its id', async () => {
    const { logger: log, lines } = capturingLogger();
    const { admin, secretStore } = setup({ records: [rec()], logger: log });
    expect(await admin.replaceGrant('personal', 'grant-secret-1')).toMatchObject({ ok: false, refusal: 'grant_unreadable' });
    expect(secretStore.set).not.toHaveBeenCalled();
    expect(lines.join('')).not.toContain('grant-secret-1');
  });

  it('refuses a non-google grant', async () => {
    const { admin } = setup({ records: [rec()], grants: { g: { email: 'pat@gmail.com', provider: 'microsoft' } } });
    expect(await admin.replaceGrant('personal', 'g')).toMatchObject({ ok: false, refusal: 'not_google' });
  });

  it('refuses a grant for a different address', async () => {
    const { admin, secretStore } = setup({ records: [rec()], grants: { g: google('someone@gmail.com') } });
    expect(await admin.replaceGrant('personal', 'g')).toMatchObject({ ok: false, refusal: 'address_mismatch' });
    expect(secretStore.set).not.toHaveBeenCalled();
  });

  it('refuses a grant another live mailbox uses', async () => {
    const { admin } = setup({
      records: two(),
      secrets: { [principalMailboxGrantSecretName('work')]: 'g' },
      grants: { g: google('pat@gmail.com') },
    });
    expect(await admin.replaceGrant('personal', 'g')).toMatchObject({ ok: false, refusal: 'grant_in_use' });
  });

  it('writes the new grant and mirrors it when the mailbox is the default', async () => {
    const { admin, secrets } = setup({
      records: [rec()],
      secrets: { [principalMailboxGrantSecretName('personal')]: 'g-old', [FLAT_GRANT]: 'g-old', [FLAT_EMAIL]: 'pat@gmail.com' },
      grants: { 'g-new': google('PAT@gmail.com') },
    });
    expect(await admin.replaceGrant('personal', 'g-new')).toEqual({ ok: true });
    expect(secrets[principalMailboxGrantSecretName('personal')]).toBe('g-new');
    expect(secrets[FLAT_GRANT]).toBe('g-new');
    expect(secrets[FLAT_EMAIL]).toBe('pat@gmail.com');
  });

  it('does not touch the flat keys for a non-default mailbox', async () => {
    const { admin, secrets } = setup({
      records: two(),
      secrets: { [principalMailboxGrantSecretName('work')]: 'g-old', [FLAT_GRANT]: 'g-personal' },
      grants: { 'g-new': google('pat@work.example.com') },
    });
    expect(await admin.replaceGrant('work', 'g-new')).toEqual({ ok: true });
    expect(secrets[principalMailboxGrantSecretName('work')]).toBe('g-new');
    expect(secrets[FLAT_GRANT]).toBe('g-personal');
  });
});

describe('PrincipalMailboxAdmin.remove "No, forget it" (R30)', () => {
  it('sets the principal identity for a migrated mailbox address inactive', async () => {
    const { admin, contacts, identities } = setup({
      records: [rec()],
      identities: [{ id: 'i1', channel: 'email', channelIdentifier: 'Pat@Gmail.com', verified: true, status: 'active' }],
    });
    await admin.remove({ id: 'personal', stillOwned: false });
    expect(contacts.setIdentityStatus).toHaveBeenCalledWith('i1', 'defunct');
    expect(identities[0]!.status).toBe('defunct');
    expect(contacts.unlinkIdentity).not.toHaveBeenCalled();
  });

  it('sets an R16 pre-existing identity inactive after an add and remove', async () => {
    const { admin, identities } = setup({
      identities: [{ id: 'old', channel: 'email', channelIdentifier: 'pat@work.example.com', verified: false, status: 'defunct' }],
      grants: { g: google('pat@work.example.com') },
    });
    await admin.add({ id: 'work', label: 'Work', grantId: 'g' });
    expect(identities[0]!.status).toBe('active');
    await admin.remove({ id: 'work', stillOwned: false });
    expect(identities[0]!.status).toBe('defunct');
  });

  it('still unlinks an identity the add created', async () => {
    const { admin, contacts, identities } = setup({ grants: { g: google('pat@work.example.com') } });
    await admin.add({ id: 'work', label: 'Work', grantId: 'g' });
    await admin.remove({ id: 'work', stillOwned: false });
    expect(contacts.unlinkIdentity).toHaveBeenCalledWith('ident-1');
    expect(identities).toHaveLength(0);
    expect(contacts.setIdentityStatus).not.toHaveBeenCalled();
  });

  it('stillOwned=true leaves the identity active', async () => {
    const { admin, contacts } = setup({
      records: [rec()],
      identities: [{ id: 'i1', channel: 'email', channelIdentifier: 'pat@gmail.com', verified: true, status: 'active' }],
    });
    await admin.remove({ id: 'personal', stillOwned: true });
    expect(contacts.setIdentityStatus).not.toHaveBeenCalled();
  });
});

describe('PrincipalMailboxAdmin.add during the deferred-migration fallback (I5)', () => {
  it('refuses cap_reached while the fallback is active, before reading the grant', async () => {
    const { admin, secretStore } = setup({
      maxLiveMailboxes: 5,
      isFallbackActive: async () => true,
      grants: { g: google('pat@work.example.com') },
    });
    expect(await admin.add({ id: 'work', label: 'Work', grantId: 'g' })).toMatchObject({ ok: false, refusal: 'cap_reached' });
    expect(secretStore.set).not.toHaveBeenCalled();
  });

  it('adds normally once the fallback is gone', async () => {
    const { admin } = setup({ isFallbackActive: async () => false, grants: { g: google('pat@work.example.com') } });
    expect(await admin.add({ id: 'work', label: 'Work', grantId: 'g' })).toMatchObject({ ok: true });
  });
});

describe('PrincipalMailboxAdmin.remove "No, forget it" with a real contact service (R30 + R32)', () => {
  it('a forgotten address no longer resolves as a verified principal identity', async () => {
    const contacts = ContactService.createInMemory();
    const principal = await contacts.createContact({ displayName: 'Pat', source: 'test' });
    await contacts.linkIdentity({ contactId: principal.id, channel: 'email', channelIdentifier: 'pat@gmail.com', source: 'ceo_stated' });
    expect((await contacts.resolveByChannelIdentity('email', 'pat@gmail.com'))?.verified).toBe(true);

    const records: PrincipalMailboxRecord[] = [rec()];
    const store = {
      listLive: async () => records.filter((r) => !r.removedAt),
      getAny: async (id: string) => records.find((r) => r.id === id) ?? null,
      insert: async () => {},
      setDefault: async () => {},
      tombstone: async (id: string) => { records.find((r) => r.id === id)!.removedAt = new Date(); },
    } as unknown as PrincipalMailboxStore;
    const vault: Record<string, string> = { [principalMailboxGrantSecretName('personal')]: 'g' };
    const admin = new PrincipalMailboxAdmin({
      store,
      secrets: {
        get: async (n) => vault[n] ?? null,
        set: async (n, v) => { vault[n] = v; },
        delete: async (n) => { delete vault[n]; },
      },
      contacts,
      principalContactId: principal.id,
      curiaAccountAddresses: async () => [],
      lookupGrant: async () => google('pat@gmail.com'),
      logger,
    });

    await admin.remove({ id: 'personal', stillOwned: false });
    const resolved = await contacts.resolveByChannelIdentity('email', 'pat@gmail.com');
    expect(resolved?.contactId).toBe(principal.id);
    expect(resolved?.verified).toBe(false);
  });
});

describe('removing a mailbox drops the legacy send-level key (#2475 R41)', () => {
  it('a new sole mailbox added after the migrated one is removed reads on_request', async () => {
    let stored: string | null = '{"default":"routine"}';
    const store = {
      get: async () => stored,
      set: async (_n: string, _k: string, v: string) => { stored = v; return {}; },
    };
    const s = setup({
      records: [rec({ id: 'work', address: 'pat@work.example.com' })],
      grants: { g2: google('pat@home.example.org') },
      forgetLegacySendLevel: () => dropLegacyDefaultKey(store),
    });
    const read = createSendLevelReader({
      get: async () => stored, logger,
      liveMailboxIds: async () => (await s.store.listLive()).map((r) => r.id),
    });
    expect(await read('work')).toBe('routine');
    await s.admin.remove({ id: 'work', stillOwned: true });
    await s.admin.add({ id: 'home', label: 'Home', grantId: 'g2' });
    expect(await read('home')).toBe('on_request');
    expect(stored).toBe('{}');
  });

  it('a failure dropping the key is named in the outcome and does not stop the other cleanup', async () => {
    const s = setup({ records: [rec({ id: 'work' })], forgetLegacySendLevel: async () => { throw new Error('kg down'); } });
    const outcome = await s.admin.remove({ id: 'work', stillOwned: true });
    expect(outcome.cleanupIncomplete).toEqual(['legacy_send_level']);
    expect(s.secretStore.delete).toHaveBeenCalledWith(principalMailboxGrantSecretName('work'));
  });
});
