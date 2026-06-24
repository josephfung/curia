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
  app.get('/api/health', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const result = await healthService.getStatus();
      const statusCode = result.status === 'down' ? 503 : 200;
      return reply.status(statusCode).send(result);
    } catch (err) {
      // If getStatus() throws, return a health-shaped 503 rather than a generic 500
      // so monitoring tools configured for 503 still alert correctly.
      request.log.error({ err }, 'Health check threw unexpectedly — returning 503');
      return reply.status(503).send({
        status: 'down' as const,
        uptime_s: -1,
        checks: {
          db: 'fail' as const,
          bus: 'fail' as const,
          signal: 'skipped' as const,
          email: 'skipped' as const,
          browser: 'skipped' as const,
          mcp: { google_workspace: 'skipped' as const },
          scheduler: 'fail' as const,
        },
      });
    }
  });
}
