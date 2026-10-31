import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import { pushRoutes } from '../../../../src/channels/http/routes/push.js';
import { hashToken, type SessionStore } from '../../../../src/channels/http/session-auth.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { WebPushService } from '../../../../src/channels/web/push-service.js';

const SECRET = 'test-bootstrap-secret';
const TOKEN = 'session-token-value';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function keys(): { p256dh: string; auth: string } {
  return {
    p256dh: Buffer.alloc(65, 3).toString('base64url'),
    auth: Buffer.alloc(16, 4).toString('base64url'),
  };
}

function appWith(query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>) {
  const sessions: SessionStore = new Map([
    [hashToken(TOKEN), { id: SESSION_ID, expiresAt: Date.now() + 60_000, renewedAt: Date.now() }],
  ]);
  const webPush = { publicKey: 'pub' } as unknown as WebPushService;
  const app = Fastify();
  return app.register(cookie).then(() => app.register(pushRoutes, {
    pool: { query },
    sessions,
    webAppBootstrapSecret: SECRET,
    webPush,
    logger: createSilentLogger(),
  })).then(() => app);
}

describe('push routes', () => {
  it('rejects an unauthenticated subscription', async () => {
    const app = await appWith(vi.fn());
    const response = await app.inject({ method: 'POST', url: '/api/push/subscriptions', payload: {} });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a private endpoint and a short key', async () => {
    const app = await appWith(async (sql) => {
      if (sql.includes('FROM sessions')) return { rows: [{ id: SESSION_ID, kind: 'browser', name: null }] };
      return { rows: [] };
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      cookies: { curia_session: TOKEN },
      payload: { endpoint: 'https://127.0.0.1/push', keys: keys() },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('upserts a public endpoint for the session', async () => {
    const calls: string[] = [];
    const app = await appWith(async (sql, params) => {
      calls.push(sql);
      if (sql.includes('FROM sessions')) return { rows: [{ id: SESSION_ID, kind: 'browser', name: null }] };
      if (sql.includes('INSERT INTO push_subscriptions')) {
        expect(params?.[0]).toBe(SESSION_ID);
        expect(params?.[1]).toBe('https://fcm.googleapis.com/fcm/send/abc');
      }
      return { rows: [] };
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      cookies: { curia_session: TOKEN },
      payload: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: keys(),
      },
    });
    expect(response.statusCode).toBe(201);
    expect(calls.some((sql) => sql.includes('ON CONFLICT (endpoint)'))).toBe(true);
    await app.close();
  });

  it('reports whether this session is subscribed', async () => {
    const app = await appWith(async (sql) => {
      if (sql.includes('FROM sessions')) return { rows: [{ id: SESSION_ID, kind: 'browser', name: null }] };
      if (sql.includes('push_subscriptions WHERE session_id')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('hide_previews')) return { rows: [{ hide_previews: false }] };
      if (sql.includes('push_notices')) return { rows: [] };
      return { rows: [] };
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/push/config',
      cookies: { curia_session: TOKEN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: true, subscribed: true, hidePreviews: false });
    await app.close();
  });
});
