import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { identityRoutes } from '../../../../src/channels/http/routes/identity.js';
import { hashToken } from '../../../../src/channels/http/session-auth.js';
import type { OfficeIdentityService } from '../../../../src/identity/service.js';
import type { OfficeIdentity } from '../../../../src/identity/types.js';

const MOCK_IDENTITY: OfficeIdentity = {
  assistant: { name: 'Alex Curia', title: 'Executive Assistant', emailSignature: 'Alex Curia\nOffice of the CEO' },
  tone: { style: 'Warm and direct.', verbosity: 50 },
  behavioralPreferences: ['Be concise'],
  constraints: ['Never impersonate the CEO'],
};

function createMockIdentityService(): OfficeIdentityService {
  return {
    get: vi.fn().mockReturnValue(MOCK_IDENTITY),
    update: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    history: vi.fn().mockResolvedValue([]),
    compileSystemPromptBlock: vi.fn().mockReturnValue(''),
    initialize: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as OfficeIdentityService;
}

const SECRET = 'test-bootstrap-secret';

// #2358: the console's first-load gate reads inSetup from this route.
describe('GET /api/identity — inSetup', () => {
  const sessions = new Map<string, { id: string; expiresAt: number; renewedAt: number }>();

  it.each([
    ['a new install that has saved nothing, which is still in Setup', [], true],
    ['Setup complete, or an install that predates the Setup page (migration 132)', [
      { key: 'setup.completed_at', value: '2026-01-01T00:00:00.000Z' },
    ], false],
  ])('%s', async (_name, settingsRows, inSetup) => {
    const pool = {
      query: vi.fn(async (sql: string) => (sql.includes('FROM settings')
        ? { rows: settingsRows }
        : { rows: [{ configured: true }] })),
    } as unknown as Pool;
    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, { identityService: createMockIdentityService(), webAppBootstrapSecret: SECRET, sessions, pool });
    const res = await app.inject({ method: 'GET', url: '/api/identity', headers: { 'x-web-bootstrap-secret': SECRET } });
    expect(res.statusCode).toBe(200);
    expect(res.json().inSetup).toBe(inSetup);
    await app.close();
  });
});

describe('GET /api/identity — configured flag', () => {
  const sessions = new Map<string, { id: string; expiresAt: number; renewedAt: number }>();

  beforeEach(() => sessions.clear());

  it('returns configured: false when only seed versions exist (no wizard/api edits)', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ configured: false }] }),
    } as unknown as Pool;

    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, {
      identityService: createMockIdentityService(),
      webAppBootstrapSecret: SECRET,
      sessions,
      pool,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/identity',
      headers: { 'x-web-bootstrap-secret': SECRET },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.identity.assistant.name).toBe('Alex Curia');
    // The Detail preview's table is the one the identity block renders (#2143).
    expect(body.lengthLimits.rows.map((r: { id: string }) => r.id)).toEqual(['message', 'email', 'voice']);
    expect(body.lengthLimits.bands[0]).toMatchObject({ maxVerbosity: 25, label: 'Brief' });
    expect(body.lengthLimits.bands[0].limits.message).toBe('1–2 sentences. The answer or outcome only.');

    await app.close();
  });

  it('returns configured: true when a wizard version exists', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ configured: true }] }),
    } as unknown as Pool;

    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, {
      identityService: createMockIdentityService(),
      webAppBootstrapSecret: SECRET,
      sessions,
      pool,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/identity',
      headers: { 'x-web-bootstrap-secret': SECRET },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().configured).toBe(true);

    await app.close();
  });

  it('accepts a valid session cookie in place of the header', async () => {
    const token = 'valid-session-token';
    sessions.set(hashToken(token), { id: 'test-session', expiresAt: Date.now() + 60_000, renewedAt: Date.now() });

    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ configured: true }] }),
    } as unknown as Pool;

    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, {
      identityService: createMockIdentityService(),
      webAppBootstrapSecret: SECRET,
      sessions,
      pool,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/identity',
      headers: { cookie: `curia_session=${token}` },
    });

    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('rejects requests with no auth', async () => {
    const pool = { query: vi.fn() } as unknown as Pool;

    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, {
      identityService: createMockIdentityService(),
      webAppBootstrapSecret: SECRET,
      sessions,
      pool,
    });

    const res = await app.inject({ method: 'GET', url: '/api/identity' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('PUT /api/identity — session cookie auth', () => {
  const sessions = new Map<string, { id: string; expiresAt: number; renewedAt: number }>();

  beforeEach(() => sessions.clear());

  it('accepts PUT with a valid session cookie', async () => {
    const token = 'put-session-token';
    sessions.set(hashToken(token), { id: 'test-session', expiresAt: Date.now() + 60_000, renewedAt: Date.now() });

    const pool = { query: vi.fn() } as unknown as Pool;
    const identityService = createMockIdentityService();

    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, {
      identityService,
      webAppBootstrapSecret: SECRET,
      sessions,
      pool,
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/identity',
      headers: { cookie: `curia_session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ identity: MOCK_IDENTITY }),
    });

    expect(res.statusCode).toBe(200);
    expect(identityService.update).toHaveBeenCalledWith(MOCK_IDENTITY, 'api', undefined);

    await app.close();
  });
  // #2358: the Setup page's tone save is recorded as such, so it doesn't count as Curia's name.
  it.each(['wizard', 'working_style', 'api'])('records changedBy %s as given', async (changedBy) => {
    const identityService = createMockIdentityService();
    const app = Fastify();
    await app.register(cookie);
    await app.register(identityRoutes, { identityService, webAppBootstrapSecret: SECRET, sessions, pool: { query: vi.fn() } as unknown as Pool });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/identity',
      headers: { 'x-web-bootstrap-secret': SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ identity: MOCK_IDENTITY, changedBy }),
    });
    expect(res.statusCode).toBe(200);
    expect(identityService.update).toHaveBeenCalledWith(MOCK_IDENTITY, changedBy, undefined);
    await app.close();
  });
});

// #2358: the router reads GET /api/identity on every navigation, so it takes the console-wide
// read limit (60/min). Writes keep the tighter cap. Uses the real rate limiter, no bypass.
describe('identity routes — rate limits', () => {
  const sessions = new Map<string, { id: string; expiresAt: number; renewedAt: number }>();

  async function build() {
    const pool = { query: vi.fn(async () => ({ rows: [{ configured: true }] })) } as unknown as Pool;
    const app = Fastify();
    await app.register(cookie);
    await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
    await app.register(identityRoutes, { identityService: createMockIdentityService(), webAppBootstrapSecret: SECRET, sessions, pool });
    return app;
  }

  it('serves 30 navigations in a minute without a 429', async () => {
    const app = await build();
    const codes: number[] = [];
    for (let i = 0; i < 30; i++) {
      codes.push((await app.inject({ method: 'GET', url: '/api/identity', headers: { 'x-web-bootstrap-secret': SECRET } })).statusCode);
    }
    expect(codes.filter((c) => c === 429)).toEqual([]);
    await app.close();
  });

  it('still caps the reload write at 10 a minute', async () => {
    const app = await build();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/api/identity/reload', headers: { 'x-web-bootstrap-secret': SECRET } })).statusCode);
    }
    expect(codes.at(-1)).toBe(429);
    await app.close();
  });
});
