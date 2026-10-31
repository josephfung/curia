import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import { sessionRoutes } from '../../../../src/channels/http/routes/sessions.js';
import {
  assertSecret,
  hashToken,
  type SessionStore,
} from '../../../../src/channels/http/session-auth.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { BusEvent, Layer } from '../../../../src/bus/events.js';
import type { SessionQueryable } from '../../../../src/channels/http/console-sessions.js';

const SECRET = 'test-bootstrap-secret';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

function makeBus(): EventBus & { published: Array<{ layer: Layer; event: BusEvent }> } {
  const published: Array<{ layer: Layer; event: BusEvent }> = [];
  return {
    published,
    async publish(layer: Layer, event: BusEvent) {
      published.push({ layer, event });
    },
  } as unknown as EventBus & { published: Array<{ layer: Layer; event: BusEvent }> };
}

function row(partial: Record<string, unknown>): Record<string, unknown> {
  return partial;
}

describe('session routes', () => {
  async function build(opts: {
    sessions?: SessionStore;
    query?: SessionQueryable['query'];
    bus?: EventBus;
  } = {}) {
    const app = Fastify();
    await app.register(cookie);
    const sessions = opts.sessions ?? new Map();
    const bus = opts.bus ?? makeBus();
    await app.register(sessionRoutes, {
      pool: { query: opts.query ?? vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
      sessions,
      webAppBootstrapSecret: SECRET,
      bus,
      logger: createSilentLogger(),
    });
    return { app, sessions, bus };
  }

  it('logout deletes the session, audits it, and clears the cookie', async () => {
    const token = 'logout-token';
    const tokenHash = hashToken(token);
    const sessions: SessionStore = new Map([[tokenHash, { expiresAt: Date.now() + 60_000, renewedAt: Date.now(), id: SESSION_ID }]]);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('token_hash = $1')) {
        return { rows: [row({ id: SESSION_ID, kind: 'browser', name: 'Mac · Chrome' })], rowCount: 1 };
      }
      if (sql.startsWith('DELETE')) {
        return { rows: [row({ id: SESSION_ID, token_hash: tokenHash, kind: 'browser', name: 'Mac · Chrome' })], rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });
    const bus = makeBus();
    const { app } = await build({ sessions, query, bus });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `curia_session=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual(expect.stringContaining('curia_session=;'));
    expect(sessions.has(tokenHash)).toBe(false);
    expect(bus.published).toHaveLength(1);
    const event = bus.published[0]!.event;
    expect(event.type).toBe('operator.session');
    if (event.type === 'operator.session') {
      expect(event.payload).toMatchObject({ action: 'logout', sessionId: SESSION_ID, kind: 'browser', name: 'Mac · Chrome' });
    }
    await app.close();
  });

  it('a later request with the logged-out cookie is rejected', async () => {
    const token = 'gone-token';
    const sessions: SessionStore = new Map();
    const { app } = await build({ sessions });
    const reply = {
      statusCode: 0,
      body: undefined as unknown,
      status(n: number) {
        this.statusCode = n;
        return { send: (b: unknown) => { this.body = b; } };
      },
    };
    const request = { cookies: { curia_session: token }, headers: {} };
    expect(assertSecret(
      request as unknown as Parameters<typeof assertSecret>[0],
      reply as unknown as Parameters<typeof assertSecret>[1],
      SECRET,
      sessions,
    )).toBe(false);
    expect(reply.statusCode).toBe(401);
    await app.close();
  });

  it('lists sessions with kind, last seen, notification status, and which one is current', async () => {
    const token = 'list-token';
    const tokenHash = hashToken(token);
    const sessions: SessionStore = new Map([[tokenHash, {
      expiresAt: Date.now() + 60_000,
      renewedAt: Date.now(),
      id: SESSION_ID,
    }]]);
    const seen = new Date('2026-10-30T15:00:00.000Z');
    const created = new Date('2026-10-01T15:00:00.000Z');
    const expires = new Date('2027-01-28T15:00:00.000Z');
    const query = vi.fn().mockResolvedValue({
      rows: [
        row({
          id: SESSION_ID,
          kind: 'browser',
          name: 'Mac · Chrome',
          user_agent: 'Mozilla/5.0',
          created_at: created,
          last_seen_at: seen,
          expires_at: expires,
        }),
        row({
          id: OTHER_ID,
          kind: 'paired_device',
          name: 'iPhone · Safari',
          user_agent: null,
          created_at: created,
          last_seen_at: seen,
          expires_at: expires,
        }),
      ],
      rowCount: 2,
    });
    const { app } = await build({ sessions, query });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: `curia_session=${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: Array<Record<string, unknown>> };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).toMatchObject({
      id: SESSION_ID,
      kind: 'browser',
      name: 'Mac · Chrome',
      current: true,
      notificationsEnabled: false,
      lastSeenAt: seen.toISOString(),
    });
    expect(body.sessions[1]).toMatchObject({
      id: OTHER_ID,
      kind: 'paired_device',
      name: 'iPhone · Safari',
      current: false,
      notificationsEnabled: false,
    });
    await app.close();
  });

  it('renames a device and rejects an empty name', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const { app } = await build({ query });
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${SESSION_ID}`,
      headers: { 'x-web-bootstrap-secret': SECRET, 'content-type': 'application/json' },
      payload: { name: '  Desk  ' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: SESSION_ID, name: 'Desk' });
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${SESSION_ID}`,
      headers: { 'x-web-bootstrap-secret': SECRET, 'content-type': 'application/json' },
      payload: { name: '   ' },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('revoke deletes the row and audits before the delete', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql.trim().slice(0, 6));
      if (sql.includes('SELECT')) {
        return {
          rows: [row({ id: OTHER_ID, token_hash: 'abc', kind: 'paired_device', name: 'iPhone · Safari' })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const bus = makeBus();
    const sessions: SessionStore = new Map([['abc', { expiresAt: Date.now() + 60_000, renewedAt: Date.now(), id: OTHER_ID }]]);
    const { app } = await build({ query, bus, sessions });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${OTHER_ID}`,
      headers: { 'x-web-bootstrap-secret': SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: true, current: false });
    expect(calls[0]).toBe('SELECT');
    expect(bus.published[0]!.event.type).toBe('operator.session');
    expect(sessions.has('abc')).toBe(false);
    await app.close();
  });

  it('sign-out-others spares the caller and audits the count', async () => {
    const token = 'keep-me';
    const tokenHash = hashToken(token);
    const sessions: SessionStore = new Map([
      [tokenHash, { expiresAt: Date.now() + 60_000, renewedAt: Date.now(), id: SESSION_ID }],
      ['other-hash', { expiresAt: Date.now() + 60_000, renewedAt: Date.now(), id: OTHER_ID }],
    ]);
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT')) {
        expect(params?.[0]).toBe(tokenHash);
        return {
          rows: [row({ id: OTHER_ID, token_hash: 'other-hash', kind: 'browser', name: 'Windows · Firefox' })],
          rowCount: 1,
        };
      }
      expect(params?.[0]).toEqual([OTHER_ID]);
      return { rows: [], rowCount: 1 };
    });
    const bus = makeBus();
    const { app } = await build({ sessions, query, bus });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/revoke-others',
      headers: { cookie: `curia_session=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 1 });
    expect(sessions.has(tokenHash)).toBe(true);
    expect(sessions.has('other-hash')).toBe(false);
    const event = bus.published[0]!.event;
    if (event.type === 'operator.session') {
      expect(event.payload).toEqual({ action: 'sign_out_others', revokedCount: 1 });
    }
    await app.close();
  });

  it('does not end sessions when the audit publish fails', async () => {
    const token = 'stay-token';
    const tokenHash = hashToken(token);
    const sessions: SessionStore = new Map([[tokenHash, { expiresAt: Date.now() + 60_000, renewedAt: Date.now(), id: SESSION_ID }]]);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('DELETE')) throw new Error('delete should not run');
      return { rows: [row({ id: SESSION_ID, kind: 'browser', name: 'Mac · Chrome' })], rowCount: 1 };
    });
    const bus = {
      async publish() { throw new Error('audit down'); },
    } as unknown as EventBus;
    const { app } = await build({ sessions, query, bus });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `curia_session=${token}` },
    });
    expect(res.statusCode).toBe(500);
    expect(sessions.has(tokenHash)).toBe(true);
    await app.close();
  });
});
