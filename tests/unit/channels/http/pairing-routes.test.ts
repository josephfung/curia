import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import { pairingRoutes } from '../../../../src/channels/http/routes/pairing.js';
import { hashToken, type SessionStore } from '../../../../src/channels/http/session-auth.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { BusEvent, Layer } from '../../../../src/bus/events.js';
import type { PairingQueryable } from '../../../../src/channels/http/pairing.js';

const SECRET = 'test-bootstrap-secret';
const TOKEN = 'abcDEF1234567890_-tokenvalue';

function makeBus(): EventBus & { published: Array<{ layer: Layer; event: BusEvent }> } {
  const published: Array<{ layer: Layer; event: BusEvent }> = [];
  return {
    published,
    async publish(layer: Layer, event: BusEvent) {
      published.push({ layer, event });
    },
  } as unknown as EventBus & { published: Array<{ layer: Layer; event: BusEvent }> };
}

function appWith(query: PairingQueryable['query'], opts?: { secureCookies?: boolean; bus?: ReturnType<typeof makeBus> }) {
  const bus = opts?.bus ?? makeBus();
  const sessions: SessionStore = new Map();
  const app = Fastify();
  return app.register(cookie).then(() => app.register(pairingRoutes, {
    pool: { query },
    sessions,
    webAppBootstrapSecret: SECRET,
    bus,
    logger: createSilentLogger(),
    secureCookies: opts?.secureCookies ?? false,
    appOrigin: 'https://curia.example.com',
  })).then(() => ({ app, bus, sessions }));
}

describe('pairing routes', () => {
  it('GET /api/pairing/origin — 401 with no auth', async () => {
    const { app } = await appWith(vi.fn());
    const response = await app.inject({ method: 'GET', url: '/api/pairing/origin' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/pairing/origin — asks when the desktop origin cannot host the app', async () => {
    const { app } = await appWith(vi.fn());
    const response = await app.inject({
      method: 'GET',
      url: '/api/pairing/origin?desktopOrigin=http%3A%2F%2Flocalhost%3A5173',
      headers: { 'x-web-bootstrap-secret': SECRET },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      origin: 'https://curia.example.com',
      askForOrigin: false,
      warning: null,
    });
    await app.close();
  });

  it('POST /api/pairing/codes — returns a fragment URL and never logs the token into the body twice', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('INSERT')) return { rows: [{ id: 'code-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const { app } = await appWith(query);
    const response = await app.inject({
      method: 'POST',
      url: '/api/pairing/codes',
      headers: { 'x-web-bootstrap-secret': SECRET },
      payload: { origin: 'https://curia.example.com' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { pairUrl: string; shortCode: string };
    expect(body.pairUrl).toMatch(/^https:\/\/curia\.example\.com\/pair#c=/);
    expect(new URL(body.pairUrl).search).toBe('');
    expect(body.shortCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await app.close();
  });

  it('POST /api/pairing/redeem — sets a Strict cookie and audits the pair without the token', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('UPDATE pairing_codes') && sql.includes('token_redeemed_at = NOW()')) {
        return { rows: [{ id: 'code-1', origin: 'https://curia.example.com' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO sessions')) {
        return { rows: [{ id: '33333333-3333-4333-8333-333333333333' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const bus = makeBus();
    const { app, sessions } = await appWith(query, { bus, secureCookies: true });
    const response = await app.inject({
      method: 'POST',
      url: '/api/pairing/redeem',
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.7 Mobile/15E148 Safari/604.1' },
      payload: { token: TOKEN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, warning: null });
    const cookie = response.headers['set-cookie'];
    expect(String(cookie)).toContain('curia_session=');
    expect(String(cookie).toLowerCase()).toContain('httponly');
    expect(String(cookie).toLowerCase()).toContain('samesite=strict');
    expect(String(cookie).toLowerCase()).toContain('secure');
    expect(bus.published).toHaveLength(1);
    const event = bus.published[0]!.event;
    expect(event.type).toBe('operator.session');
    expect(event.payload).toMatchObject({ action: 'pair', kind: 'paired_device' });
    expect(JSON.stringify(event.payload)).not.toContain(TOKEN);
    expect(sessions.size).toBe(1);
    const stored = [...sessions.keys()][0];
    expect(stored).not.toBe(TOKEN);
    expect(stored).toBe(hashToken(String(cookie).split('curia_session=')[1]?.split(';')[0]));
    await app.close();
  });

  it('POST /api/pairing/redeem — 401 when the code is spent, with no cookie', async () => {
    const { app } = await appWith(vi.fn(async () => ({ rows: [], rowCount: 0 })));
    const response = await app.inject({
      method: 'POST',
      url: '/api/pairing/redeem',
      payload: { shortCode: 'ABCD-2345' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('POST /api/pairing/redeem — leaves no session when the audit publish throws', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('token_redeemed_at = NOW()')) {
        return { rows: [{ id: 'code-1', origin: 'http://192.168.1.8:3000' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO sessions')) {
        return { rows: [{ id: '33333333-3333-4333-8333-333333333333' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const bus = {
      published: [] as BusEvent[],
      async publish() {
        throw new Error('audit down');
      },
    } as unknown as ReturnType<typeof makeBus>;
    const { app, sessions } = await appWith(query, { bus });
    const response = await app.inject({
      method: 'POST',
      url: '/api/pairing/redeem',
      payload: { token: TOKEN },
    });
    expect(response.statusCode).toBe(500);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessions.size).toBe(0);
    const release = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes('= NULL'));
    expect(release).toContain('token_redeemed_at = NULL');
    await app.close();
  });
});
