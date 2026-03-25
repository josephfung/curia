import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../../../../src/channels/http/routes/health.js';
import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('GET /api/health', () => {
  const mockPool = {
    query: async () => ({ rows: [{ '?column?': 1 }] }),
  } as unknown as Pool;

  const app = Fastify();

  beforeAll(async () => {
    app.register(healthRoutes, {
      pool: mockPool,
      logger,
      agentNames: ['coordinator', 'research-analyst'],
      skillNames: ['web-fetch', 'delegate'],
    });
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
    expect(body.database).toBe('connected');
    expect(body.agents).toEqual(['coordinator', 'research-analyst']);
    expect(body.skills).toEqual(['web-fetch', 'delegate']);
    expect(body).toHaveProperty('uptime');
  });

  it('returns 503 when database is down', async () => {
    const failPool = {
      query: async () => { throw new Error('connection refused'); },
    } as unknown as Pool;

    const failApp = Fastify();
    failApp.register(healthRoutes, {
      pool: failPool,
      logger,
      agentNames: ['coordinator'],
      skillNames: [],
    });
    await failApp.ready();

    const response = await failApp.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('disconnected');

    await failApp.close();
  });
});
