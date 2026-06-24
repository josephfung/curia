// health.ts — GET /api/health endpoint (thin shim over HealthService).
//
// All probe logic lives in HealthService. This route calls getStatus() and maps
// the three-state result to HTTP status codes: 503 for 'down', 200 for all else.

import type { FastifyInstance } from 'fastify';
import type { HealthService } from '../../../health/health-service.js';

export interface HealthRouteOptions {
  healthService: HealthService;
}

export async function healthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  const { healthService } = options;

  // Permissive rate limit: 60 req/min per IP — allows monitoring tools to probe every
  // second while still preventing denial-of-service from rogue scanners.
  app.get('/api/health', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_request, reply) => {
    const result = await healthService.getStatus();
    const statusCode = result.status === 'down' ? 503 : 200;
    return reply.status(statusCode).send(result);
  });
}
