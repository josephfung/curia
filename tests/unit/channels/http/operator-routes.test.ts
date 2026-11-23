// The console's Operator setting (#2710, ADR-068): view, set, clear, and the confirmation
// notice that stands in for a fallback when the address is mistyped.
//
// The store's SQL is covered against a real database in tests/integration/settings-store.test.ts;
// this file covers the route: validation (unknown fields refused, name and email always as a
// pair), what the response says about the confirmation notice, and that clearing means no notice.
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
function makePool(
  initial: { value: unknown; updatedBy: string } | null = null,
  initialConfirmation?: { email: string; attemptedAt: string; sentAt: string | null },
) {
  let stored = initial;
  let confirmation = initialConfirmation;
  const history: Array<{ id: string; key: string; old_value: unknown; new_value: unknown; updated_by: string; changed_at: Date }> = [];

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT value FROM settings')) {
        const key = String(params![0]);
        const value = key === 'operator' ? stored?.value : key === 'operator_confirmation' ? confirmation : undefined;
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
        const key = String(params![0]);
        const value = JSON.parse(String(params![1]));
        if (key === 'operator_confirmation') confirmation = value;
        else stored = { value, updatedBy: String(params![2]) };
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
        if (confirmation) rows.push({ key: 'operator_confirmation', value: confirmation, updated_by: 'curia' });
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
  return { pool, history, current: () => stored, confirmation: () => confirmation };
}

interface Harness {
  app: FastifyInstance;
  sendNotification: ReturnType<typeof vi.fn>;
}

async function makeApp(
  pool: ReturnType<typeof makePool>['pool'],
  opts: { withGateway?: boolean } = {},
): Promise<Harness> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  const sendNotification = vi.fn().mockResolvedValue('sent');
  await app.register(operatorRoutes, {
    webAppBootstrapSecret: SECRET,
    sessions: new Map() as SessionStore,
    pool: pool as never,
    logger: createSilentLogger(),
    ...(opts.withGateway === false ? {} : { outboundGateway: { publishNotification: sendNotification } }),
    appOrigin: 'https://curia.example.com',
  });
  await app.ready();
  return { app, sendNotification };
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
    expect(res.json()).toEqual({ operator: null, updatedBy: null, confirmation: { state: 'none' } });
    await app.close();
  });

  it('saves the pair, stores it, and says the confirmation went out', async () => {
    const { app, sendNotification } = await makeApp(pool.pool);
    const res = await put(app, { name: 'Sam Rivera', email: 'sam@example.com' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      operator: { name: 'Sam Rivera', email: 'sam@example.com' },
      confirmation: { state: 'sent', email: 'sam@example.com' },
    });
    expect(pool.current()).toMatchObject({ value: { name: 'Sam Rivera', email: 'sam@example.com' } });
    // The confirmation is the smoke test for a typo, and it is operator-routed.
    expect(sendNotification).toHaveBeenCalledOnce();
    const notice = sendNotification.mock.calls[0]![0] as { notificationType: string; body: string };
    expect(notice.notificationType).toBe('operator_configured');
    expect(notice.body).toContain('Sam Rivera');
    // No recipient is named: the gateway resolves the (just saved) operator address.
    expect(notice).not.toHaveProperty('recipient');
    await app.close();
  });

  it('reports a confirmation that could not be published, without failing the save', async () => {
    const { app, sendNotification } = await makeApp(pool.pool);
    sendNotification.mockResolvedValue('not_sent');
    const res = await put(app, { name: 'Sam Rivera', email: 'sam@example.com' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      operator: { name: 'Sam Rivera', email: 'sam@example.com' },
      confirmation: { state: 'failed', email: 'sam@example.com' },
    });
    // The setting is saved: a notice that failed must not undo it.
    expect(pool.current()).not.toBeNull();
    await app.close();
  });

  it('saves and reports the miss when no outbound gateway exists', async () => {
    const { app } = await makeApp(pool.pool, { withGateway: false });
    // Nothing can deliver it, so the notice is owed rather than failed: that is what the console
    // says, and a later boot or Start retries it.
    const res = await put(app, { name: 'Sam Rivera', email: 'sam@example.com' });
    expect(res.json()).toMatchObject({ confirmation: { state: 'pending' } });
    expect(pool.current()).not.toBeNull();
    await app.close();
  });

  it('clears the operator, and sends no confirmation: there is nowhere to send it', async () => {
    pool = makePool({ value: { name: 'Sam Rivera', email: 'sam@example.com' }, updatedBy: 'console' });
    const { app, sendNotification } = await makeApp(pool.pool);
    const res = await put(app, { clear: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ operator: null, confirmation: { state: 'none' } });
    expect(pool.current()).toBeNull();
    expect(sendNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not re-send a confirmation already sent when the saved operator is unchanged', async () => {
    const at = '2026-11-22T12:00:00.000Z';
    pool = makePool(
      { value: { name: 'Sam Rivera', email: 'sam@example.com' }, updatedBy: 'console' },
      { email: 'sam@example.com', attemptedAt: at, sentAt: at },
    );
    const { app, sendNotification } = await makeApp(pool.pool);
    const res = await put(app, { name: 'Sam Rivera', email: 'sam@example.com' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ confirmation: { state: 'sent', sentAt: at } });
    expect(sendNotification).not.toHaveBeenCalled();
    // No write either: an unchanged save adds no history row.
    expect(pool.history.filter((row) => row.key === 'operator')).toHaveLength(0);
    await app.close();
  });

  it('retries an owed confirmation on an unchanged save, pending or failed, without rewriting the operator', async () => {
    for (const owed of [undefined, { email: 'sam@example.com', attemptedAt: '2026-11-22T12:00:00.000Z', sentAt: null }]) {
      pool = makePool({ value: { name: 'Sam Rivera', email: 'sam@example.com' }, updatedBy: 'console' }, owed);
      const { app, sendNotification } = await makeApp(pool.pool);
      const res = await put(app, { name: 'Sam Rivera', email: 'sam@example.com' });

      expect(res.statusCode).toBe(200);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(res.json()).toMatchObject({ confirmation: { state: 'sent', email: 'sam@example.com' } });
      expect(pool.history.filter((row) => row.key === 'operator')).toHaveLength(0);
      await app.close();
    }
  });

  it('keeps a committed save when the confirmation step throws: 200, saved, and failed (never sent)', async () => {
    const { app } = await makeApp(pool.pool);
    // The first settings read is the unchanged-save check; every read after the save fails, so
    // working out the confirmation throws once the operator is already written.
    const realQuery = pool.pool.query.getMockImplementation()!;
    let reads = 0;
    pool.pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM settings WHERE key = ANY') && ++reads > 1) throw new Error('settings read failed');
      return realQuery(sql);
    });
    const res = await put(app, { name: 'Sam Rivera', email: 'sam@example.com' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      operator: { name: 'Sam Rivera', email: 'sam@example.com' },
      confirmation: { state: 'failed', email: 'sam@example.com' },
    });
    expect(pool.current()).toMatchObject({ value: { name: 'Sam Rivera', email: 'sam@example.com' } });
    await app.close();
  });

  it('reports a pending confirmation on GET while one is owed', async () => {
    pool = makePool({ value: { name: 'Sam Rivera', email: 'sam@example.com' }, updatedBy: 'console' });
    const { app } = await makeApp(pool.pool);
    const res = await app.inject({ method: 'GET', url: '/api/operator', headers: { 'x-web-bootstrap-secret': SECRET } });
    expect(res.json()).toMatchObject({ confirmation: { state: 'pending', email: 'sam@example.com' } });
    await app.close();
  });

  it('answers 400 for a half-saved or invalid pair, and writes nothing', async () => {
    const { app, sendNotification } = await makeApp(pool.pool);
    expect((await put(app, { name: 'Sam' })).statusCode).toBe(400);
    expect((await put(app, { name: 'Sam', email: 'nope' })).statusCode).toBe(400);
    expect(pool.current()).toBeNull();
    expect(sendNotification).not.toHaveBeenCalled();
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
