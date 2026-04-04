import Fastify from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from '../../../../src/logger.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { knowledgeGraphRoutes } from '../../../../src/channels/http/routes/kg.js';

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe('knowledgeGraphRoutes', () => {
  const pool = {
    query: vi.fn(),
  } as unknown as Pick<Pool, 'query'>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects API requests without x-web-bootstrap-secret', async () => {
    const app = Fastify();
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'secret-1',
    });

    const response = await app.inject({ method: 'GET', url: '/api/kg/nodes' });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('returns node results when authenticated', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          type: 'person',
          label: 'Ada Lovelace',
          properties: { role: 'founder' },
          confidence: 0.9,
          decay_class: 'slow_decay',
          source: 'seed',
          created_at: '2026-01-01T00:00:00.000Z',
          last_confirmed_at: '2026-01-02T00:00:00.000Z',
        },
      ],
    });

    const app = Fastify();
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'secret-1',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/kg/nodes?query=ada',
      headers: { 'x-web-bootstrap-secret': 'secret-1' },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.nodes).toHaveLength(1);
    expect(payload.nodes[0].label).toBe('Ada Lovelace');

    await app.close();
  });

  it('serves the UI shell', async () => {
    const app = Fastify();
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'secret-1',
    });

    const response = await app.inject({ method: 'GET', url: '/kg' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Knowledge Graph Explorer');

    await app.close();
  });
});
