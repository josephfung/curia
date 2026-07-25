import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import cookie from '@fastify/cookie';
import {
  systemRoutes,
  resolveSystemSnapshot,
  type SystemSnapshot,
} from '../../../../src/channels/http/routes/system.js';
import { hashToken } from '../../../../src/channels/http/session-auth.js';

const SECRET = 'test-bootstrap-secret';

const SNAPSHOT: SystemSnapshot = {
  version: '0.41.0',
  nodeVersion: 'v24.14.0',
  timezone: 'America/Toronto',
  bootedAt: '2026-07-25T12:00:00.000Z',
  models: {
    defaultTier: 'standard',
    tiers: [
      { tier: 'fast', model: 'claude-haiku-4-5' },
      { tier: 'standard', model: 'claude-sonnet-4-6' },
      { tier: 'powerful', model: 'claude-opus-4-6' },
    ],
  },
};

describe('resolveSystemSnapshot', () => {
  it('maps tier → model preserving YAML order and passes runtime facts through', () => {
    const resolved = resolveSystemSnapshot({
      version: '0.41.0',
      nodeVersion: 'v24.14.0',
      timezone: 'America/Toronto',
      bootedAt: '2026-07-25T12:00:00.000Z',
      modelRouting: {
        default_tier: 'standard',
        tiers: {
          fast: { model: 'claude-haiku-4-5' },
          standard: { model: 'claude-sonnet-4-6' },
          powerful: { model: 'claude-opus-4-6' },
        },
      },
    });
    expect(resolved).toEqual(SNAPSHOT);
  });

  it('defaults the tier to "standard" when default_tier is omitted', () => {
    const resolved = resolveSystemSnapshot({
      version: '1.0.0',
      nodeVersion: 'v24.0.0',
      timezone: 'UTC',
      bootedAt: '2026-01-01T00:00:00.000Z',
      modelRouting: { tiers: { standard: { model: 'm' } } },
    });
    expect(resolved.models.defaultTier).toBe('standard');
    expect(resolved.models.tiers).toEqual([{ tier: 'standard', model: 'm' }]);
  });
});

describe('GET /api/system', () => {
  const sessions = new Map<string, number>();

  beforeEach(() => sessions.clear());

  async function buildApp() {
    const app = Fastify();
    await app.register(cookie);
    await app.register(systemRoutes, {
      system: SNAPSHOT,
      webAppBootstrapSecret: SECRET,
      sessions,
    });
    return app;
  }

  it('returns the boot-time system snapshot', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/system',
      headers: { 'x-web-bootstrap-secret': SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ system: SNAPSHOT });
    await app.close();
  });

  it('accepts a valid session cookie', async () => {
    const token = 'valid-session-token';
    sessions.set(hashToken(token), Date.now() + 60_000);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/system',
      headers: { cookie: `curia_session=${token}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects unauthenticated requests', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/system' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
