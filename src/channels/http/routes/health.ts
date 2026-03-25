// health.ts — GET /api/health endpoint.
//
// Reports system status: database connectivity, registered agents,
// loaded skills, and process uptime. Returns 200 for healthy, 503
// for degraded (e.g., database is down).

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export interface HealthRouteOptions {
  pool: Pool;
  agentNames: string[];
  skillNames: string[];
}

export async function healthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  const { pool, agentNames, skillNames } = options;
  const startTime = Date.now();

  app.get('/api/health', async (_request, reply) => {
    let dbStatus = 'connected';

    try {
      await pool.query('SELECT 1');
    } catch {
      dbStatus = 'disconnected';
    }

    const status = dbStatus === 'connected' ? 'ok' : 'degraded';
    const statusCode = status === 'ok' ? 200 : 503;

    return reply.status(statusCode).send({
      status,
      database: dbStatus,
      agents: agentNames,
      skills: skillNames,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });
}
