// Integration test — MailboxSignInService against real Postgres (#2361). Skips without DATABASE_URL.
// Rows are keyed by the hash of tokens minted here; cleanup removes only rows this suite created.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { hashToken } from '../../src/channels/http/session-auth.js';
import {
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

  function makeService(over: { readiness?: NylasSignInReadiness; principalEmail?: string | null; appOrigin?: string } = {}): MailboxSignInService {
    return new MailboxSignInService({
      pool,
      logger,
      appOrigin: over.appOrigin ?? ORIGIN,
      readiness: async () => over.readiness ?? READY,
      resolvePrincipalEmail: () => (over.principalEmail === undefined ? 'boss@example.com' : over.principalEmail),
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
    expect(await svc.peek(raw)).toBe('expired');
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
