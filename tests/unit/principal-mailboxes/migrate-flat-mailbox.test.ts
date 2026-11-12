import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  migrateFlatPrincipalMailbox,
  mailboxIdFromAddress,
} from '../../../src/principal-mailboxes/migrate-flat-mailbox.js';
import type { PrincipalMailboxStore } from '../../../src/principal-mailboxes/store.js';
import type { PrincipalMailboxRecord } from '../../../src/principal-mailboxes/types.js';

const logger = pino({ level: 'silent' });

function setup(flat: Record<string, string>, lookup: () => Promise<{ email: string; provider: string }>) {
  const rows: Array<Omit<PrincipalMailboxRecord, 'removedAt'>> = [];
  const store = {
    listLive: vi.fn(async () => rows.map((r) => ({ ...r, removedAt: null }))),
    insert: vi.fn(async (r: Omit<PrincipalMailboxRecord, 'removedAt'>) => { rows.push(r); }),
  } as unknown as PrincipalMailboxStore;
  const vault: Record<string, string> = { ...flat };
  const secrets = {
    get: vi.fn(async (n: string) => vault[n] ?? null),
    set: vi.fn(async (n: string, v: string) => { vault[n] = v; }),
  };
  const lookupGrant = vi.fn(lookup);
  return { rows, store, secrets, vault, lookupGrant, deps: { store, secrets, lookupGrant, logger } };
}

describe('migrateFlatPrincipalMailbox', () => {
  it('migrates the flat grant into one default mailbox named from the grant domain', async () => {
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => ({ email: 'pat@ops.example.org', provider: 'google' }));
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('migrated');
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      id: 'ops', label: 'Ops', address: 'pat@ops.example.org', provider: 'google',
      isDefault: true, triageStartAt: null, addedIdentityId: null,
    });
    expect(t.vault['principal.mailbox.ops.nylas_grant_id']).toBe('g1');
    expect(t.vault['ceo_nylas_grant_id']).toBe('g1');
  });

  it('uses ceo_self_email when the grant lookup fails', async () => {
    const t = setup({ ceo_nylas_grant_id: 'g1', ceo_self_email: 'Pat@Gmail.com' }, async () => { throw new Error('nylas down'); });
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('migrated');
    expect(t.rows[0]).toMatchObject({ id: 'gmail', address: 'pat@gmail.com' });
  });

  it('defers when neither address source is available', async () => {
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => { throw new Error('nylas down'); });
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('deferred');
    expect(t.rows).toHaveLength(0);
    expect(t.secrets.set).not.toHaveBeenCalled();
  });

  it('is a no-op when a live mailbox exists', async () => {
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => ({ email: 'pat@ops.example.org', provider: 'google' }));
    await migrateFlatPrincipalMailbox(t.deps);
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('already');
    expect(t.rows).toHaveLength(1);
  });

  it('returns nothing when there is no flat grant', async () => {
    const t = setup({ ceo_nylas_grant_id: '  ' }, async () => ({ email: 'a@b.example', provider: 'google' }));
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('nothing');
    expect(t.lookupGrant).not.toHaveBeenCalled();
  });

  it('deferred then migrated once', async () => {
    let up = false;
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => {
      if (!up) throw new Error('down');
      return { email: 'pat@work.example.com', provider: 'google' };
    });
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('deferred');
    up = true;
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('migrated');
    expect(t.rows).toHaveLength(1);
  });
});

describe('mailboxIdFromAddress', () => {
  it('maps domains to ids', () => {
    expect(mailboxIdFromAddress('a@gmail.com')).toBe('gmail');
    expect(mailboxIdFromAddress('a@googlemail.com')).toBe('gmail');
    expect(mailboxIdFromAddress('a@ops.example.org')).toBe('ops');
    expect(mailboxIdFromAddress('a@9co.example')).toBe('m-9co');
  });
});
