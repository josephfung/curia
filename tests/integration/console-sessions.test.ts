// A console session stored in Postgres authenticates again after the in-memory
// map is thrown away — the stand-in for a process restart (#2341).
// Skips when DATABASE_URL is unset. CI migrates before the suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  issueSession,
  loadActiveSessions,
  SESSION_RENEW_INTERVAL_MS,
  SessionKeeper,
} from '../../src/channels/http/console-sessions.js';
import { assertSecret, bindSessionRenewer, hashToken, type SessionStore } from '../../src/channels/http/session-auth.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('console sessions survive a restart (integration)', () => {
  let pool: pg.Pool;
  const created: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT kind, name, user_agent FROM sessions LIMIT 0');
  });

  afterAll(async () => {
    try {
      if (created.length > 0) {
        await pool.query('DELETE FROM sessions WHERE token_hash = ANY($1::text[])', [created]);
      }
    } finally {
      await pool.end();
    }
  });

  it('reloads a persisted session into a fresh map and accepts the cookie', async () => {
    const first = new Map() as SessionStore;
    const issued = await issueSession(pool, first, {
      kind: 'browser',
      name: 'Mac · Chrome',
      userAgent: 'Mozilla/5.0 (test)',
    });
    created.push(issued.tokenHash);

    const restarted = new Map() as SessionStore;
    const loaded = await loadActiveSessions(pool, restarted);
    expect(loaded).toBeGreaterThan(0);
    const restored = restarted.get(issued.tokenHash);
    expect(restored).toMatchObject({ id: issued.id });

    const request = {
      headers: {},
      cookies: { curia_session: issued.token },
    } as unknown as FastifyRequest;
    const reply = {
      status() { return { send() { /* unused */ } }; },
      setCookie() { /* renewal may no-op; the row was just written */ },
    } as unknown as FastifyReply;
    expect(assertSecret(request, reply, 'configured', restarted)).toBe(true);

    await pool.query('UPDATE sessions SET expires_at = NOW() - interval \'1 minute\' WHERE token_hash = $1', [issued.tokenHash]);
    const expired = new Map() as SessionStore;
    await loadActiveSessions(pool, expired);
    expect(expired.has(hashToken(issued.token))).toBe(false);
    expect(assertSecret(request, reply, 'configured', expired)).toBe(false);
  });

  it('keeps a slid expiry after the in-memory map is reloaded', async () => {
    const first = new Map() as SessionStore;
    const issued = await issueSession(pool, first, {
      kind: 'browser',
      name: 'Mac · Chrome',
      userAgent: 'Mozilla/5.0 (test)',
    });
    created.push(issued.tokenHash);
    const planted = first.get(issued.tokenHash);
    expect(planted).toBeDefined();
    first.set(issued.tokenHash, {
      id: planted!.id,
      expiresAt: planted!.expiresAt,
      renewedAt: Date.now() - SESSION_RENEW_INTERVAL_MS - 1_000,
    });
    const keeper = new SessionKeeper({
      pool,
      sessions: first,
      secureCookies: false,
      logger: createSilentLogger(),
    });
    bindSessionRenewer(first, keeper);
    const reply = { setCookie() { /* cookie is not under test */ } } as unknown as FastifyReply;
    keeper.touch(issued.tokenHash, issued.token, reply, 'Mozilla/5.0 (test)');
    await viWaitForRow(pool, issued.tokenHash);

    const restarted = new Map() as SessionStore;
    await loadActiveSessions(pool, restarted);
    const restored = restarted.get(issued.tokenHash);
    expect(restored).toBeDefined();
    expect(restored!.expiresAt).toBeGreaterThan(Date.now() + 80 * 24 * 60 * 60 * 1000);
  });
});

async function viWaitForRow(pool: pg.Pool, tokenHash: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      'SELECT expires_at FROM sessions WHERE token_hash = $1',
      [tokenHash],
    );
    const expires = result.rows[0]?.expires_at as Date | undefined;
    if (expires && expires.getTime() > Date.now() + 80 * 24 * 60 * 60 * 1000) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('slid expiry was not written');
}
