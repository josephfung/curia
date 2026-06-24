// health.test.ts — legacy test, updated to use the new HealthService shim.
//
// The old route took pool/logger/agentNames/skillNames directly and did its own
// db probe. Task 7 replaced that with a thin shim over HealthService.getStatus().
// These tests now use a mock HealthService consistent with the new interface.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../../../../src/channels/http/routes/health.js';
import type { HealthService } from '../../../../src/health/health-service.js';

describe('GET /api/health', () => {
  const healthServiceOk = {
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
  } as unknown as HealthService;

  const app = Fastify();

  beforeAll(async () => {
    app.register(healthRoutes, { healthService: healthServiceOk });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with system status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.uptime_s).toBe(42);
    expect(body.checks.db).toBe('ok');
  });

  it('returns 503 when health service says down', async () => {
    const healthServiceDown = {
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
    } as unknown as HealthService;

    const failApp = Fastify();
    failApp.register(healthRoutes, { healthService: healthServiceDown });
    await failApp.ready();

    const response = await failApp.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('down');

    await failApp.close();
  });
});
