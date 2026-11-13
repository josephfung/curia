import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  migrateFlatPrincipalMailbox,
  mailboxIdFromAddress,
  migrationFailureReason,
} from '../../../src/principal-mailboxes/migrate-flat-mailbox.js';
import type { PrincipalMailboxStore } from '../../../src/principal-mailboxes/store.js';
import { MAILBOX_ID_RE, RESERVED_MAILBOX_IDS, type PrincipalMailboxRecord } from '../../../src/principal-mailboxes/types.js';

const logger = pino({ level: 'silent' });

function setup(
  flat: Record<string, string>,
  lookup: () => Promise<{ email: string; provider: string }>,
  opts: { insertFails?: boolean; insertError?: unknown; log?: pino.Logger; isVerifiedPrincipalEmail?: (a: string) => Promise<boolean> } = {},
) {
  const rows: Array<Omit<PrincipalMailboxRecord, 'removedAt'>> = [];
  const store = {
    hasAnyRow: vi.fn(async () => rows.length > 0),
    insert: vi.fn(async (r: Omit<PrincipalMailboxRecord, 'removedAt'>) => {
      if (opts.insertError) throw opts.insertError;
      if (opts.insertFails) throw new Error('insert failed');
      rows.push(r);
    }),
  } as unknown as PrincipalMailboxStore;
  const vault: Record<string, string> = { ...flat };
  const secrets = {
    get: vi.fn(async (n: string) => vault[n] ?? null),
    set: vi.fn(async (n: string, v: string) => { vault[n] = v; }),
    delete: vi.fn(async (n: string) => { delete vault[n]; }),
  };
  const lookupGrant = vi.fn(lookup);
  return {
    rows, store, secrets, vault, lookupGrant,
    deps: { store, secrets, lookupGrant, logger: opts.log ?? logger, isVerifiedPrincipalEmail: opts.isVerifiedPrincipalEmail },
  };
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

  it.each([
    ['a grant of another provider', async () => ({ email: 'pat@outlook.example.com', provider: 'microsoft' }), {}, /not a Google account/],
    ["one of Curia's own addresses", async () => ({ email: 'curia@example.com', provider: 'google' }), { curiaAccountAddresses: async () => ['Curia@example.com'] }, /Curia's own email accounts/],
    ["one of Curia's own grants", async () => ({ email: 'pat@example.org', provider: 'google' }), { curiaAccountGrantIds: async () => ['g1'] }, /Curia's own email accounts/],
  ] as const)('defers, never inserting, for %s (F5)', async (_name, lookup, extra, reason) => {
    const t = setup({ ceo_nylas_grant_id: 'g1' }, lookup);
    const onDeferred = vi.fn();
    expect(await migrateFlatPrincipalMailbox({ ...t.deps, ...extra, onDeferred })).toBe('deferred');
    expect(t.rows).toHaveLength(0);
    expect(t.secrets.set).not.toHaveBeenCalled();
    expect(onDeferred).toHaveBeenCalledWith(expect.stringMatching(reason));
  });

  it('points a Nylas failure at the Nylas settings and anything else at the server log', () => {
    expect(migrationFailureReason(Object.assign(new Error('grants/g1'), { name: 'NylasApiError', statusCode: 401 })))
      .toBe('The last attempt failed (NylasApiError, HTTP 401); check the Nylas API key and the grant');
    const db = migrationFailureReason(new Error('relation "principal_mailboxes" is locked'));
    expect(db).toBe('The last attempt failed (Error); see the server log for the cause');
    expect(db).not.toMatch(/Nylas/);
  });

  it('tells why it deferred when no address is known', async () => {
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => { throw new Error('down'); });
    const onDeferred = vi.fn();
    expect(await migrateFlatPrincipalMailbox({ ...t.deps, onDeferred })).toBe('deferred');
    expect(onDeferred).toHaveBeenCalledWith(expect.stringContaining('ceo_self_email is not set'));
  });

  it('is a no-op when a live mailbox exists', async () => {
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => ({ email: 'pat@ops.example.org', provider: 'google' }));
    await migrateFlatPrincipalMailbox(t.deps);
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('already');
    expect(t.rows).toHaveLength(1);
  });

  it('does not revive a removed mailbox', async () => {
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => ({ email: 'pat@ops.example.org', provider: 'google' }));
    // A tombstoned row still counts: hasAnyRow is true while listLive would be empty.
    (t.store.hasAnyRow as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('already');
    expect(t.rows).toHaveLength(0);
    expect(t.secrets.set).not.toHaveBeenCalled();
  });

  it('removes the grant secret it wrote when the insert fails', async () => {
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => ({ email: 'pat@ops.example.org', provider: 'google' }), { insertFails: true });
    await expect(migrateFlatPrincipalMailbox(t.deps)).rejects.toThrow('insert failed');
    expect(t.vault['principal.mailbox.ops.nylas_grant_id']).toBeUndefined();
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

function capture(): { log: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: pino({ level: 'debug' }, { write: (s: string) => { lines.push(s); } }), lines };
}

describe('migrateFlatPrincipalMailbox hardening (#2475 Part-1 fixes)', () => {
  it('never logs the grant id carried by a Nylas timeout error (R20)', async () => {
    const { log, lines } = capture();
    const timeout = Object.assign(new Error('Nylas SDK timed out'), {
      name: 'NylasSdkTimeoutError', url: 'https://api.us.nylas.com/v3/grants/grant-secret-1',
    });
    const t = setup({ ceo_nylas_grant_id: 'grant-secret-1', ceo_self_email: 'pat@gmail.com' }, async () => { throw timeout; }, { log });
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('migrated');
    const out = lines.join('');
    expect(out).toContain('NylasSdkTimeoutError');
    expect(out).not.toContain('grant-secret-1');
  });

  it('keeps the secret and reports already when a concurrent boot inserted first (23505)', async () => {
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => ({ email: 'pat@ops.example.org', provider: 'google' }), {
      insertError: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    });
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('already');
    expect(t.secrets.delete).not.toHaveBeenCalled();
    expect(t.vault['principal.mailbox.ops.nylas_grant_id']).toBe('g1');
  });

  it('still removes the secret and rethrows on any other insert failure', async () => {
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => ({ email: 'pat@ops.example.org', provider: 'google' }), {
      insertError: Object.assign(new Error('check violation'), { code: '23514' }),
    });
    await expect(migrateFlatPrincipalMailbox(t.deps)).rejects.toThrow('check violation');
    expect(t.vault['principal.mailbox.ops.nylas_grant_id']).toBeUndefined();
  });

  it('warns, without the address, when the migrated address is not a verified principal email (D1)', async () => {
    const { log, lines } = capture();
    const check = vi.fn(async () => false);
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => ({ email: 'pat@ops.example.org', provider: 'google' }), { log, isVerifiedPrincipalEmail: check });
    expect(await migrateFlatPrincipalMailbox(t.deps)).toBe('migrated');
    expect(check).toHaveBeenCalledWith('pat@ops.example.org');
    const out = lines.join('');
    expect(out).toContain("the migrated mailbox's address is not a verified principal email");
    expect(out).not.toContain('pat@ops.example.org');
  });

  it('does not warn when the migrated address is a verified principal email', async () => {
    const { log, lines } = capture();
    const t = setup({ ceo_nylas_grant_id: 'g1' }, async () => ({ email: 'pat@ops.example.org', provider: 'google' }), { log, isVerifiedPrincipalEmail: async () => true });
    await migrateFlatPrincipalMailbox(t.deps);
    expect(lines.join('')).not.toContain('not a verified principal email');
  });
});

describe('mailboxIdFromAddress', () => {
  it('maps domains to ids', () => {
    expect(mailboxIdFromAddress('a@gmail.com')).toBe('gmail');
    expect(mailboxIdFromAddress('a@googlemail.com')).toBe('gmail');
    expect(mailboxIdFromAddress('a@ops.example.org')).toBe('ops');
    expect(mailboxIdFromAddress('a@9co.example')).toBe('m-9co');
  });

  it('always yields a valid, non-reserved id', () => {
    const cases: Record<string, string> = {
      'a@primary.com': 'm-primary',
      'a@default.org': 'm-default',
      'a@-x.example': 'm--x',
      'a@!!!.example': 'mailbox',
      ['a@' + 'x'.repeat(40) + '.example']: 'x'.repeat(32),
      ['a@9' + 'x'.repeat(40) + '.example']: 'm-9' + 'x'.repeat(29),
    };
    for (const [addr, want] of Object.entries(cases)) {
      const id = mailboxIdFromAddress(addr);
      expect(id).toBe(want);
      expect(id).toMatch(MAILBOX_ID_RE);
      expect(RESERVED_MAILBOX_IDS.has(id)).toBe(false);
    }
  });
});
