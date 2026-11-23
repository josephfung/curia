// The console's Operator setting (#2710, ADR-068): view, set, clear and the change history.
//
// The store's SQL is covered against a real database in tests/integration/settings-store.test.ts;
// this file covers the route: validation (unknown fields refused, name and email always as a
// pair), the saved value, and the cache refresh after every write.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { operatorRoutes, parseOperatorUpdate } from '../../../../src/channels/http/routes/operator.js';
import { createSilentLogger } from '../../../../src/logger.js';
import { hashToken, type SessionStore } from '../../../../src/channels/http/session-auth.js';
import { createBearerAuthHook } from '../../../../src/channels/http/auth.js';

const SECRET = 'test-bootstrap-secret';

/** A pool whose settings table holds one key, and whose history holds what a test says. */
function makePool(initial: { value: unknown; updatedBy: string } | null = null) {
  let stored = initial;
  const history: Array<{ id: string; key: string; old_value: unknown; new_value: unknown; updated_by: string; changed_at: Date }> = [];

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT value FROM settings')) {
        const key = String(params![0]);
        const value = key === 'operator' ? stored?.value : undefined;
        return { rows: value === undefined ? [] : [{ value }] };
      }
      // The history INSERT also starts with "INSERT INTO settings", so it is matched first.
      if (sql.includes('INSERT INTO settings_history')) {
        history.unshift({
          id: String(history.length + 1),
          key: String(params![0]),
          old_value: params![1] === null ? null : JSON.parse(String(params![1])),
          new_value: params![2] === null ? null : JSON.parse(String(params![2])),
          updated_by: String(params![3]),
          changed_at: new Date('2026-11-22T12:00:00.000Z'),
        });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO settings')) {
        const value = JSON.parse(String(params![1]));
        stored = { value, updatedBy: String(params![2]) };
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM settings')) {
        const old = stored;
        stored = null;
        return { rows: old ? [{ value: old.value }] : [] };
      }
      throw new Error(`unexpected client SQL: ${sql}`);
    }),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM settings WHERE key = ANY')) {
        const rows: Array<Record<string, unknown>> = [];
        if (stored) rows.push({ key: 'operator', value: stored.value, updated_by: stored.updatedBy });
        return { rows };
      }
      const forKey = (rows: typeof history) => rows.filter((row) => row.key === 'operator');
      if (sql.includes('FROM settings_history') && sql.includes('count(*)')) {
        return { rows: [{ total: forKey(history).length }] };
      }
      if (sql.includes('FROM settings_history')) {
        return { rows: forKey(history) };
      }
      throw new Error(`unexpected pool SQL: ${sql}`);
    }),
  };
  return { pool, history, current: () => stored };
}

interface Harness {
  app: FastifyInstance;
  onOperatorChanged: ReturnType<typeof vi.fn>;
}

async function makeApp(pool: ReturnType<typeof makePool>['pool']): Promise<Harness> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  const onOperatorChanged = vi.fn();
  await app.register(operatorRoutes, {
    webAppBootstrapSecret: SECRET,
    sessions: new Map() as SessionStore,
    pool: pool as never,
    logger: createSilentLogger(),
    onOperatorChanged,
  });
  await app.ready();
  return { app, onOperatorChanged };
}

function put(app: FastifyInstance, body: unknown) {
  return app.inject({
    method: 'PUT',
    url: '/api/operator',
    headers: { 'x-web-bootstrap-secret': SECRET },
    payload: body as Record<string, unknown>,
  });
}

describe('parseOperatorUpdate', () => {
  it('refuses unknown fields rather than ignoring them', () => {
    expect(parseOperatorUpdate({ name: 'Sam', email: 'sam@example.com', role: 'admin' }))
      .toEqual({ error: 'Unknown field: role.' });
  });

  it('requires both halves of the operator', () => {
    expect(parseOperatorUpdate({ name: 'Sam' })).toEqual({ error: "Send the operator's name and email together." });
    expect(parseOperatorUpdate({ email: 'sam@example.com' })).toEqual({ error: "Send the operator's name and email together." });
  });

  it('validates through the registry, so the route and the store agree', () => {
    const bad = parseOperatorUpdate({ name: 'Sam', email: 'not-an-address' });
    expect(bad).toEqual({ error: 'Invalid operator: email must be an email address.' });
    // The registry normalizes: trimmed name, lower-cased address.
    expect(parseOperatorUpdate({ name: '  Sam Rivera ', email: 'Sam@Example.com ' }))
      .toEqual({ operator: { name: 'Sam Rivera', email: 'sam@example.com' } });
  });

  it('accepts an explicit clear, and only on its own', () => {
    expect(parseOperatorUpdate({ clear: true })).toEqual({ clear: true });
    expect(parseOperatorUpdate({ clear: false })).toEqual({ error: 'clear must be true when given.' });
    expect(parseOperatorUpdate({ clear: true, email: 'sam@example.com' }))
      .toEqual({ error: 'Send either clear or the operator details, not both.' });
  });
});

describe('operator routes', () => {
  let pool: ReturnType<typeof makePool>;

  beforeEach(() => {
    pool = makePool(null);
  });

  it('reports no operator on a fresh install', async () => {
    const { app } = await makeApp(pool.pool);
    const res = await app.inject({ method: 'GET', url: '/api/operator', headers: { 'x-web-bootstrap-secret': SECRET } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ operator: null, updatedBy: null });
    await app.close();
  });

  it('saves the pair, stores it, and refreshes the cached operator', async () => {
    const { app, onOperatorChanged } = await makeApp(pool.pool);
    const res = await put(app, { name: 'Sam Rivera', email: 'sam@example.com' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ operator: { name: 'Sam Rivera', email: 'sam@example.com' } });
    expect(pool.current()).toMatchObject({ value: { name: 'Sam Rivera', email: 'sam@example.com' } });
    expect(onOperatorChanged).toHaveBeenCalledWith({ name: 'Sam Rivera', email: 'sam@example.com' });
    await app.close();
  });

  it('clears the operator, and tells the cache', async () => {
    pool = makePool({ value: { name: 'Sam Rivera', email: 'sam@example.com' }, updatedBy: 'console' });
    const { app, onOperatorChanged } = await makeApp(pool.pool);
    const res = await put(app, { clear: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ operator: null });
    expect(pool.current()).toBeNull();
    expect(onOperatorChanged).toHaveBeenCalledWith(null);
    await app.close();
  });

  it('writes nothing when the saved operator is unchanged', async () => {
    pool = makePool({ value: { name: 'Sam Rivera', email: 'sam@example.com' }, updatedBy: 'console' });
    const { app } = await makeApp(pool.pool);
    const res = await put(app, { name: 'Sam Rivera', email: 'sam@example.com' });

    expect(res.statusCode).toBe(200);
    expect(pool.history).toHaveLength(0);
    await app.close();
  });

  it('answers 400 for a half-saved or invalid pair, and writes nothing', async () => {
    const { app } = await makeApp(pool.pool);
    expect((await put(app, { name: 'Sam' })).statusCode).toBe(400);
    expect((await put(app, { name: 'Sam', email: 'nope' })).statusCode).toBe(400);
    expect(pool.current()).toBeNull();
    await app.close();
  });

  it('returns the change history newest first, with each write as one row', async () => {
    const { app } = await makeApp(pool.pool);
    // Two writes: set, then a console clear. Each is one history row, in the same transaction.
    await put(app, { name: 'Sam Rivera', email: 'sam@example.com' });
    await put(app, { clear: true });

    const res = await app.inject({
      method: 'GET',
      url: '/api/operator/history?limit=10&offset=0',
      headers: { 'x-web-bootstrap-secret': SECRET },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { history: Array<{ previous: unknown; current: unknown; changedBy: string }>; total: number };
    expect(body.total).toBe(2);
    // Newest write first: the clear.
    expect(body.history[0]).toMatchObject({ current: null, changedBy: 'console' });
    expect(body.history[1]).toMatchObject({ previous: null, current: { name: 'Sam Rivera', email: 'sam@example.com' } });
    await app.close();
  });

  it('requires auth on every route', async () => {
    const { app } = await makeApp(pool.pool);
    expect((await app.inject({ method: 'GET', url: '/api/operator' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/operator', payload: { clear: true } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/operator/history' })).statusCode).toBe(401);
    await app.close();
  });
});

// The adapter puts a bearer-token hook in front of every /api route. With API_TOKEN set (as in
// production), a console route missing from the bypass list is refused there, before its own
// session check can run (#2710 review). So test the routes behind the adapter's own hook.
describe('operator routes behind the adapter auth hook, with an API token set', () => {
  const API_TOKEN = 'api-token-for-tests';
  const COOKIE = 'operator-route-session-cookie';

  async function adapterApp() {
    const sessions: SessionStore = new Map();
    sessions.set(hashToken(COOKIE), { id: 'session-1', expiresAt: Date.now() + 60 * 60 * 1000, renewedAt: Date.now() });
    const app = Fastify();
    await app.register(cookie);
    await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
    app.addHook('onRequest', createBearerAuthHook(API_TOKEN, createSilentLogger()));
    await app.register(operatorRoutes, {
      webAppBootstrapSecret: SECRET,
      sessions,
      pool: makePool().pool as never,
      logger: createSilentLogger(),
    });
    // A plain API route the bypass list does not name, to show the hook is enforcing.
    app.get('/api/agents/status', async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it('lets a console session with no bearer token reach every operator route', async () => {
    const app = await adapterApp();
    const headers = { cookie: `curia_session=${COOKIE}` };
    expect((await app.inject({ method: 'GET', url: '/api/operator', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/operator/history', headers })).statusCode).toBe(200);
    const put = await app.inject({ method: 'PUT', url: '/api/operator', headers, payload: { clear: true } });
    expect(put.statusCode).toBe(200);
    await app.close();
  });

  it('still refuses a request with neither a session nor the bootstrap secret, through the route check', async () => {
    const app = await adapterApp();
    const res = await app.inject({ method: 'GET', url: '/api/operator' });
    expect(res.statusCode).toBe(401);
    // The route's own refusal, not the bearer hook's: the hook let it through to assertSecret.
    expect(res.json().error).not.toContain('Bearer');
    await app.close();
  });

  it('keeps enforcing the bearer token on routes outside the bypass list', async () => {
    const app = await adapterApp();
    const headers = { cookie: `curia_session=${COOKIE}` };
    const res = await app.inject({ method: 'GET', url: '/api/agents/status', headers });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain('Bearer');
    await app.close();
  });
});
