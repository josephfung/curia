// Integration test — MailboxSignInService against real Postgres (#2361). Skips without DATABASE_URL.
// Rows are keyed by the hash of tokens minted here; cleanup removes only rows this suite created.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { hashToken } from '../../src/channels/http/session-auth.js';
import {
  MailboxSignInAddressError,
  MailboxSignInRefusedError,
  MailboxSignInService,
  MailboxSignInUnavailableError,
} from '../../src/nylas/mailbox-signin-service.js';
import type { NylasSignInReadiness } from '../../src/nylas/signin-readiness.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = pino({ level: 'silent' });
const ORIGIN = 'https://curia.example.com';

const READY: NylasSignInReadiness = { ready: true, applicationId: 'app-1', region: 'us' };

describeIf('MailboxSignInService', () => {
  let pool: pg.Pool;
  let databaseValidated = false;
  const hashes: string[] = [];

  function makeService(over: {
    readiness?: NylasSignInReadiness;
    emails?: { primary: string | null; all: string[] };
    appOrigin?: string;
    hasCuriaMailbox?: (() => Promise<boolean>) | null;
    isFallbackActive?: () => Promise<boolean>;
  } = {}): MailboxSignInService {
    return new MailboxSignInService({
      pool,
      logger,
      appOrigin: over.appOrigin ?? ORIGIN,
      readiness: async () => over.readiness ?? READY,
      principalEmails: () => over.emails ?? { primary: 'boss@example.com', all: ['boss@example.com', 'Work@Example.com'] },
      ...(over.hasCuriaMailbox === null ? {} : { hasCuriaMailbox: over.hasCuriaMailbox ?? (async () => false) }),
      ...(over.isFallbackActive ? { isFallbackActive: over.isFallbackActive } : {}),
    });
  }

  /** Mint and remember the hash for cleanup. Returns the raw token from the URL. */
  async function mintToken(service: MailboxSignInService, args: Parameters<MailboxSignInService['mint']>[0]): Promise<{ raw: string; url: string; expiresAt: Date }> {
    const { url, expiresAt } = await service.mint(args);
    const raw = url.slice(url.lastIndexOf('/') + 1);
    hashes.push(hashToken(raw));
    return { raw, url, expiresAt };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    databaseValidated = true;
  });

  afterEach(async () => {
    if (databaseValidated && hashes.length > 0) {
      await pool.query('DELETE FROM mailbox_signin_tokens WHERE token_hash = ANY($1)', [hashes.splice(0)]);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('mints a link under the app origin, then peek returns the row', async () => {
    const svc = makeService();
    const { raw, url, expiresAt } = await mintToken(svc, { target: 'principal', label: 'Work' });
    expect(url).toBe(`${ORIGIN}/api/mailbox-signin/start/${raw}`);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    const row = await svc.peek(raw);
    expect(row).toMatchObject({ target: 'principal', expected_email: 'boss@example.com', mailbox_label: 'Work', consumed_at: null });
  });

  it('fills the principal address in code, never from the caller, and leaves it empty for curia', async () => {
    const svc = makeService();
    const principal = await mintToken(svc, { target: 'principal' });
    const curia = await mintToken(svc, { target: 'curia' });
    expect(await svc.peek(principal.raw)).toMatchObject({ expected_email: 'boss@example.com' });
    expect(await svc.peek(curia.raw)).toMatchObject({ target: 'curia', expected_email: null });
  });

  it('pins a principal link to a requested verified address, case-insensitively', async () => {
    const svc = makeService();
    const { raw } = await mintToken(svc, { target: 'principal', mailboxAddress: ' WORK@example.com ' });
    expect(await svc.peek(raw)).toMatchObject({ expected_email: 'work@example.com' });
  });

  it('refuses an address that is not a verified principal address, and writes nothing', async () => {
    const svc = makeService();
    const before = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    await expect(svc.mint({ target: 'principal', mailboxAddress: 'stranger@example.com' }))
      .rejects.toMatchObject({ reason: 'unknown_principal_address' });
    const after = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('pins to a new address when the caller allows it, normalized', async () => {
    const svc = makeService();
    const { raw } = await mintToken(svc, { target: 'principal', mailboxAddress: '  New.Job@Acme.COM ', allowNewAddress: true });
    expect(await svc.peek(raw)).toMatchObject({ expected_email: 'new.job@acme.com' });
  });

  it('refuses a new address when the caller does not allow it, and writes nothing', async () => {
    const svc = makeService();
    const before = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    for (const allowNewAddress of [false, undefined]) {
      await expect(svc.mint({ target: 'principal', mailboxAddress: 'new@acme.com', ...(allowNewAddress === undefined ? {} : { allowNewAddress }) }))
        .rejects.toMatchObject({ reason: 'unknown_principal_address' });
    }
    const after = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('refuses a malformed new address even when allowed, and writes nothing', async () => {
    const svc = makeService();
    const before = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    for (const bad of ['not-an-email', 'a@b', 'a b@acme.com', 'a@@acme.com', 'a@acme.com, b@acme.com', '<a@acme.com>', '@acme.com', 'a@']) {
      await expect(svc.mint({ target: 'principal', mailboxAddress: bad, allowNewAddress: true }))
        .rejects.toMatchObject({ reason: 'unknown_principal_address' });
    }
    const after = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('uses the only verified address when none is designated, and refuses when it is ambiguous or absent', async () => {
    const one = makeService({ emails: { primary: null, all: ['solo@example.com'] } });
    const { raw } = await mintToken(one, { target: 'principal' });
    expect(await one.peek(raw)).toMatchObject({ expected_email: 'solo@example.com' });
    for (const emails of [{ primary: null, all: ['a@example.com', 'b@example.com'] }, { primary: null, all: [] }]) {
      const err = await makeService({ emails }).mint({ target: 'principal' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MailboxSignInAddressError);
      expect(err).toMatchObject({ reason: 'no_principal_address' });
    }
  });

  it('operator mint may pin or leave any account; skills\' minter has no such path', async () => {
    const svc = makeService({ emails: { primary: null, all: [] } });
    const { url } = await svc.mintForOperator({ target: 'principal', expectedEmail: 'New@Example.com' });
    const raw = url.slice(url.lastIndexOf('/') + 1);
    hashes.push(hashToken(raw));
    expect(await svc.peek(raw)).toMatchObject({ expected_email: 'new@example.com' });
  });

  it('prunes rows lapsed over a day ago and rows spent over an hour ago, and keeps live ones', async () => {
    const svc = makeService();
    const live = await mintToken(svc, { target: 'principal' });
    const lapsed = await mintToken(svc, { target: 'principal' });
    const spent = await mintToken(svc, { target: 'principal' });
    await pool.query("UPDATE mailbox_signin_tokens SET expires_at = now() - interval '2 days' WHERE token_hash = $1", [hashToken(lapsed.raw)]);
    await pool.query("UPDATE mailbox_signin_tokens SET consumed_at = now() - interval '2 hours' WHERE token_hash = $1", [hashToken(spent.raw)]);
    await svc.pruneExpired();
    expect(await svc.peek(lapsed.raw)).toBe('not_found');
    expect(await svc.peek(spent.raw)).toBe('not_found');
    expect(await svc.peek(live.raw)).toMatchObject({ target: 'principal' });
  });

  it('keeps a lapsed row for a day, so a late claim still reads expired (C)', async () => {
    const svc = makeService();
    const recent = await mintToken(svc, { target: 'principal' });
    const old = await mintToken(svc, { target: 'principal' });
    await pool.query("UPDATE mailbox_signin_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [hashToken(recent.raw)]);
    await pool.query("UPDATE mailbox_signin_tokens SET expires_at = now() - interval '25 hours' WHERE token_hash = $1", [hashToken(old.raw)]);
    await svc.pruneExpired();
    expect(await svc.peek(old.raw)).toBe('not_found');
    expect((await svc.claim(recent.raw)).status).toBe('expired');
  });

  it("refuses an agent-minted Curia link once any Curia account exists, and writes nothing (A, R8)", async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    const svc = makeService({ hasCuriaMailbox: async () => true });
    const err = await svc.mint({ target: 'curia' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailboxSignInRefusedError);
    expect(err).toMatchObject({ reason: 'curia_mailbox_exists' });
    expect((err as Error).message).toMatch(/console/);
    const after = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('refuses an agent-minted Curia link when it cannot tell whether a Curia account exists (fail closed)', async () => {
    const svc = makeService({ hasCuriaMailbox: null });
    await expect(svc.mint({ target: 'curia' })).rejects.toBeInstanceOf(MailboxSignInRefusedError);
  });

  it('allows an agent-minted Curia link before any Curia account exists, capped at 15 minutes (A, R8)', async () => {
    const svc = makeService({ hasCuriaMailbox: async () => false });
    const { raw, expiresAt } = await mintToken(svc, { target: 'curia', ttlMinutes: 600 });
    expect(await svc.peek(raw)).toMatchObject({ target: 'curia', expected_email: null });
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 30_000);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it('caps an unpinned operator Curia link at 15 minutes; a pinned one keeps its TTL and address (A, R8)', async () => {
    const svc = makeService({ hasCuriaMailbox: async () => true });
    const unpinned = await svc.mintForOperator({ target: 'curia' });
    const pinned = await svc.mintForOperator({ target: 'curia', expectedEmail: ' Assistant@Office.com ' });
    for (const l of [unpinned, pinned]) hashes.push(hashToken(l.url.slice(l.url.lastIndexOf('/') + 1)));
    expect(unpinned.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 30_000);
    expect(pinned.expiresAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(await svc.peek(pinned.url.slice(pinned.url.lastIndexOf('/') + 1))).toMatchObject({ target: 'curia', expected_email: 'assistant@office.com' });
  });

  it('refuses a principal link while the flat-mailbox fallback is served, by agent or operator (B, R9)', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    const svc = makeService({ isFallbackActive: async () => true });
    for (const p of [svc.mint({ target: 'principal' }), svc.mintForOperator({ target: 'principal', expectedEmail: 'boss@example.com' })]) {
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MailboxSignInUnavailableError);
      expect(err).toMatchObject({ reason: 'migration_pending' });
    }
    const after = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('stores only the hash of the token', async () => {
    const svc = makeService();
    const { raw } = await mintToken(svc, { target: 'principal' });
    const rows = await pool.query<{ token_hash: string }>('SELECT token_hash FROM mailbox_signin_tokens WHERE token_hash = $1', [hashToken(raw)]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.token_hash).not.toBe(raw);
    const leaked = await pool.query('SELECT 1 FROM mailbox_signin_tokens WHERE token_hash = $1', [raw]);
    expect(leaked.rowCount).toBe(0);
  });

  it('persists the origin routing so the callback can resume the agent', async () => {
    const svc = makeService();
    const { raw } = await mintToken(svc, {
      target: 'principal',
      origin: { conversationId: 'c1', channelId: 'web', agentId: 'setup-wizard', taskEventId: 't1', originator: { a: 1 }, resumeToken: 'rt' },
    });
    expect(await svc.peek(raw)).toMatchObject({
      conversation_id: 'c1', channel_id: 'web', agent_id: 'setup-wizard', task_event_id: 't1', originator: { a: 1 }, resume_token: 'rt',
    });
  });

  it('consume claims the row once; the second consume is used', async () => {
    const svc = makeService();
    const { raw } = await mintToken(svc, { target: 'principal' });
    const first = await svc.consume(raw);
    expect(first).toMatchObject({ target: 'principal' });
    expect(await svc.consume(raw)).toBe('used');
    // A consumed link no longer starts a sign-in.
    expect(await svc.peek(raw)).toBe('used');
  });

  it('consume of an unknown token is not_found', async () => {
    const svc = makeService();
    expect(await svc.consume('nope-nope-nope-nope-nope')).toBe('not_found');
    expect(await svc.peek('nope-nope-nope-nope-nope')).toBe('not_found');
  });

  it('consume after expiry returns expired and marks the row consumed', async () => {
    const svc = makeService();
    const { raw } = await mintToken(svc, { target: 'principal' });
    await pool.query("UPDATE mailbox_signin_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [hashToken(raw)]);
    expect(await svc.peek(raw)).toBe('expired');
    expect(await svc.consume(raw)).toBe('expired');
    const row = await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM mailbox_signin_tokens WHERE token_hash = $1', [hashToken(raw)]);
    expect(row.rows[0]!.consumed_at).not.toBeNull();
    // Replaying it reports a spent link, not a fresh expiry.
    expect(await svc.consume(raw)).toBe('used');
  });

  it('concurrent consumes: exactly one wins', async () => {
    const svc = makeService();
    const { raw } = await mintToken(svc, { target: 'principal' });
    const results = await Promise.all([svc.consume(raw), svc.consume(raw), svc.consume(raw)]);
    expect(results.filter((r) => typeof r === 'object')).toHaveLength(1);
    expect(results.filter((r) => r === 'used')).toHaveLength(2);
  });

  it('caps the lifetime at 10080 minutes and defaults to 60', async () => {
    const svc = makeService();
    const long = await mintToken(svc, { target: 'principal', ttlMinutes: 999_999 });
    const dflt = await mintToken(svc, { target: 'principal' });
    const week = 10080 * 60_000;
    expect(long.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + week + 60_000);
    expect(long.expiresAt.getTime()).toBeGreaterThan(Date.now() + week - 60_000);
    expect(dflt.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 61 * 60_000);
  });

  it('refuses to mint when sign-in is not ready, and writes nothing', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    const svc = makeService({ readiness: { ready: false, reason: 'origin_not_https', detail: 'needs https' } });
    await expect(svc.mint({ target: 'principal' })).rejects.toBeInstanceOf(MailboxSignInUnavailableError);
    await expect(svc.mint({ target: 'principal' })).rejects.toMatchObject({ reason: 'origin_not_https' });
    const after = await pool.query('SELECT count(*)::int AS n FROM mailbox_signin_tokens');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
