import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { identityRoutes } from '../../../../src/channels/http/routes/identity.js';
import type { OfficeIdentityService } from '../../../../src/identity/service.js';
import type { OfficeIdentity } from '../../../../src/identity/types.js';

const MOCK_IDENTITY: OfficeIdentity = {
  assistant: { name: 'Alex Curia', title: 'Executive Assistant', emailSignature: 'Alex Curia\nOffice of the CEO' },
  tone: { baseline: ['warm', 'direct'], verbosity: 50, directness: 75 },
  behavioralPreferences: ['Be concise'],
  decisionStyle: { externalActions: 'conservative', internalAnalysis: 'proactive' },
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

describe('GET /api/identity — configured flag', () => {
  const sessions = new Map<string, number>();

  beforeEach(() => sessions.clear());

  it('returns configured: false when only file_load versions exist', async () => {
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
    sessions.set(token, Date.now() + 60_000);

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
  const sessions = new Map<string, number>();

  beforeEach(() => sessions.clear());

  it('accepts PUT with a valid session cookie', async () => {
    const token = 'put-session-token';
    sessions.set(token, Date.now() + 60_000);

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
});
