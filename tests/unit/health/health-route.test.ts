import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../../../src/channels/http/routes/health.js';

describe('GET /api/health', () => {
  it('returns 200 and ok status when health service says ok', async () => {
    const app = Fastify();
    const healthService = {
      getStatus: vi.fn().mockResolvedValue({
        status: 'ok',
        uptime_s: 42,
        checks: {
          db: 'ok', bus: 'ok', signal: 'skipped',
          email: 'skipped', browser: 'skipped',
          mcp: { google_workspace: 'skipped' },
          scheduler: 'ok',
        },
      }),
    };
    await app.register(healthRoutes, { healthService } as never);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.uptime_s).toBe(42);
    expect(body.checks.db).toBe('ok');
  });

  it('returns 503 when health service says down', async () => {
    const app = Fastify();
    const healthService = {
      getStatus: vi.fn().mockResolvedValue({
        status: 'down',
        uptime_s: 5,
        checks: {
          db: 'fail', bus: 'ok', signal: 'skipped',
          email: 'skipped', browser: 'skipped',
          mcp: { google_workspace: 'skipped' },
          scheduler: 'ok',
        },
      }),
    };
    await app.register(healthRoutes, { healthService } as never);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
  });

  it('returns 200 when health service says degraded', async () => {
    const app = Fastify();
    const healthService = {
      getStatus: vi.fn().mockResolvedValue({
        status: 'degraded',
        uptime_s: 100,
        checks: {
          db: 'ok', bus: 'ok', signal: 'fail',
          email: 'skipped', browser: 'skipped',
          mcp: { google_workspace: 'skipped' },
          scheduler: 'ok',
        },
      }),
    };
    await app.register(healthRoutes, { healthService } as never);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('degraded');
  });
});
