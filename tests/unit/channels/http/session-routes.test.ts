import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import { sessionRoutes } from '../../../../src/channels/http/routes/sessions.js';
import {
  bindSessionRenewer,
  hashToken,
  type SessionStore,
} from '../../../../src/channels/http/session-auth.js';
import { SESSION_RENEW_INTERVAL_MS, SessionKeeper, sessionCookieOptions, writeSseHead } from '../../../../src/channels/http/console-sessions.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { BusEvent, Layer } from '../../../../src/bus/events.js';
import type { SessionQueryable } from '../../../../src/channels/http/console-sessions.js';

const SECRET = 'test-bootstrap-secret';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

function makeBus(calls?: string[]): EventBus & { published: Array<{ layer: Layer; event: BusEvent }> } {
  const published: Array<{ layer: Layer; event: BusEvent }> = [];
  return {
    published,
    async publish(layer: Layer, event: BusEvent) {
      calls?.push('PUBLISH');
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
    expect(bus.published).toHaveLength(2);
    const stages = bus.published.map((item) => item.event.type === 'operator.session' ? item.event.payload.stage : '');
    expect(stages).toEqual(['requested', 'completed']);
    const event = bus.published[0]!.event;
    expect(event.type).toBe('operator.session');
    if (event.type === 'operator.session') {
      expect(event.payload).toMatchObject({
        action: 'logout',
        sessionId: SESSION_ID,
        kind: 'browser',
        name: 'Mac · Chrome',
        initiatedBy: 'session',
        actorSessionId: SESSION_ID,
      });
    }
    await app.close();
  });

  it('POST /auth/logout ends the session and the old cookie then gets 401', async () => {
    const token = 'gone-token';
    const tokenHash = hashToken(token);
    const sessions: SessionStore = new Map([[tokenHash, {
      expiresAt: Date.now() + 60_000,
      renewedAt: Date.now(),
      id: SESSION_ID,
    }]]);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('token_hash = $1')) {
        return { rows: [row({ id: SESSION_ID, kind: 'browser', name: 'Mac · Chrome' })], rowCount: 1 };
      }
      if (sql.startsWith('DELETE')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected sql: ${sql}`);
    });
    const { app } = await build({ sessions, query });
    const loggedOut = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `curia_session=${token}` },
    });
    expect(loggedOut.statusCode).toBe(200);
    const again = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: `curia_session=${token}` },
    });
    expect(again.statusCode).toBe(401);
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
    const bus = makeBus(calls);
    const sessions: SessionStore = new Map([['abc', { expiresAt: Date.now() + 60_000, renewedAt: Date.now(), id: OTHER_ID }]]);
    const { app } = await build({ query, bus, sessions });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${OTHER_ID}`,
      headers: { 'x-web-bootstrap-secret': SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: true, current: false });
    expect(calls).toEqual(['SELECT', 'PUBLISH', 'DELETE', 'PUBLISH']);
    expect(bus.published[0]!.event.type).toBe('operator.session');
    if (bus.published[0]!.event.type === 'operator.session') {
      expect(bus.published[0]!.event.payload).toMatchObject({
        stage: 'requested',
        initiatedBy: 'bootstrap_secret',
        sessionId: OTHER_ID,
      });
    }
    expect(sessions.has('abc')).toBe(false);
    await app.close();
  });

  it('revoking the current session clears the cookie', async () => {
    const token = 'current-token';
    const tokenHash = hashToken(token);
    const sessions: SessionStore = new Map([[tokenHash, {
      expiresAt: Date.now() + 60_000,
      renewedAt: Date.now(),
      id: SESSION_ID,
    }]]);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT')) {
        return {
          rows: [row({ id: SESSION_ID, token_hash: tokenHash, kind: 'browser', name: 'Mac · Chrome' })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const { app } = await build({ sessions, query });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${SESSION_ID}`,
      headers: { cookie: `curia_session=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: true, current: true });
    expect(String(res.headers['set-cookie'])).toContain('curia_session=;');
    expect(sessions.has(tokenHash)).toBe(false);
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
    const requested = bus.published[0]!.event;
    if (requested.type === 'operator.session') {
      expect(requested.payload).toMatchObject({
        action: 'sign_out_others',
        stage: 'requested',
        initiatedBy: 'session',
        actorSessionId: SESSION_ID,
        revokedCount: 1,
        revokedSessionIds: [OTHER_ID],
      });
    }
    await app.close();
  });

  it('revoke-others with only the bootstrap header ends every live session', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT')) {
        expect(params?.[0]).toBeNull();
        return {
          rows: [row({ id: SESSION_ID, token_hash: 'a', kind: 'browser', name: 'Mac' })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const bus = makeBus();
    const { app } = await build({ query, bus });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/revoke-others',
      headers: { 'x-web-bootstrap-secret': SECRET },
    });
    expect(res.statusCode).toBe(200);
    const event = bus.published[0]!.event;
    if (event.type === 'operator.session') {
      expect(event.payload.initiatedBy).toBe('bootstrap_secret');
      expect(event.payload.revokedSessionIds).toEqual([SESSION_ID]);
    }
    await app.close();
  });

  it('does not revoke when the audit publish fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('DELETE')) throw new Error('delete should not run');
      return {
        rows: [row({ id: OTHER_ID, token_hash: 'abc', kind: 'browser', name: 'Mac' })],
        rowCount: 1,
      };
    });
    const bus = { async publish() { throw new Error('audit down'); } } as unknown as EventBus;
    const sessions: SessionStore = new Map([['abc', { expiresAt: Date.now() + 60_000, renewedAt: Date.now(), id: OTHER_ID }]]);
    const { app } = await build({ query, bus, sessions });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${OTHER_ID}`,
      headers: { 'x-web-bootstrap-secret': SECRET },
    });
    expect(res.statusCode).toBe(500);
    expect(sessions.has('abc')).toBe(true);
    await app.close();
  });

  it('does not sign out others when the audit publish fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('DELETE')) throw new Error('delete should not run');
      return {
        rows: [row({ id: OTHER_ID, token_hash: 'other', kind: 'browser', name: null })],
        rowCount: 1,
      };
    });
    const bus = { async publish() { throw new Error('audit down'); } } as unknown as EventBus;
    const { app } = await build({ query, bus });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/revoke-others',
      headers: { 'x-web-bootstrap-secret': SECRET },
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it('records a failed revoke when the delete throws', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql.trim().slice(0, 6));
      if (sql.includes('SELECT')) {
        return {
          rows: [row({ id: OTHER_ID, token_hash: 'abc', kind: 'browser', name: 'Mac' })],
          rowCount: 1,
        };
      }
      throw new Error('db down');
    });
    const bus = makeBus(calls);
    const sessions: SessionStore = new Map([['abc', { expiresAt: Date.now() + 60_000, renewedAt: Date.now(), id: OTHER_ID }]]);
    const { app } = await build({ query, bus, sessions });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${OTHER_ID}`,
      headers: { 'x-web-bootstrap-secret': SECRET },
    });
    expect(res.statusCode).toBe(503);
    expect(sessions.has('abc')).toBe(true);
    expect(calls[0]).toBe('SELECT');
    expect(calls).toContain('PUBLISH');
    const stages = bus.published.map((item) => item.event.type === 'operator.session' ? item.event.payload.stage : '');
    expect(stages).toEqual(['requested', 'failed']);
    await app.close();
  });

  it('reissues a 90-day cookie when the renewer is bound and the hour has elapsed', async () => {
    const token = 'renew-me';
    const tokenHash = hashToken(token);
    const now = Date.now();
    const sessions: SessionStore = new Map([[tokenHash, {
      id: SESSION_ID,
      expiresAt: now + 60_000,
      renewedAt: now - SESSION_RENEW_INTERVAL_MS - 1,
    }]]);
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    bindSessionRenewer(sessions, new SessionKeeper({
      pool: { query },
      sessions,
      secureCookies: true,
      logger: createSilentLogger(),
    }));
    const { app } = await build({ sessions, query });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: `curia_session=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=7776000');
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

  it('writes a pending session cookie onto a hijacked SSE response', async () => {
    const app = Fastify();
    await app.register(cookie);
    app.get('/stream', async (_request, reply) => {
      reply.setCookie('curia_session', 'renewed-token', sessionCookieOptions(true));
      reply.hijack();
      writeSseHead(reply, { 'Content-Type': 'text/event-stream' });
      reply.raw.end('data: ok\n\n');
    });
    const res = await app.inject({ method: 'GET', url: '/stream' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('curia_session=renewed-token');
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=7776000');
    await app.close();
  });
});
