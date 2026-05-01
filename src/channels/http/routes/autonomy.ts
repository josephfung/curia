// autonomy.ts — HTTP routes for the Autonomy Settings API.
//
// All routes require session cookie or x-web-bootstrap-secret authentication
// (same pattern as identity.ts and kg.ts). Routes are only accessible when
// webAppBootstrapSecret is configured.
//
// Endpoints:
//   GET /api/autonomy         — return current autonomy config with band description
//   PUT /api/autonomy         — update the autonomy score
//   GET /api/autonomy/history — return paginated history of score changes

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// Value import (not type-only) because we call AutonomyService.bandDescription() as a static method.
import { AutonomyService } from '../../../autonomy/autonomy-service.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface AutonomyRouteOptions {
  autonomyService: AutonomyService;
  webAppBootstrapSecret: string;
  // Shared session store from HttpAdapter — allows browser sessions (cookie auth)
  // to call autonomy routes without the raw bootstrap secret being stored in JS.
  sessions: SessionStore;
}

export async function autonomyRoutes(
  app: FastifyInstance,
  options: AutonomyRouteOptions,
): Promise<void> {
  const { autonomyService, webAppBootstrapSecret, sessions } = options;

  // Auth helper — validates session cookie or bootstrap secret on every request.
  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // -- GET /api/autonomy — return current autonomy config --

  app.get('/api/autonomy', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const config = await autonomyService.getConfig();

      if (!config) {
        // Pre-migration state — config row does not exist yet.
        return reply.send({ autonomy: null });
      }

      return reply.send({
        autonomy: {
          score: config.score,
          band: config.band,
          // Include the human-readable behavioral description for the UI to display.
          bandDescription: AutonomyService.bandDescription(config.band),
          updatedAt: config.updatedAt,
          updatedBy: config.updatedBy,
        },
      });
    } catch (err) {
      request.log.error({ err }, 'GET /api/autonomy: failed to retrieve autonomy config');
      return reply.status(500).send({ error: 'Failed to get autonomy config. Check server logs.' });
    }
  });

  // -- PUT /api/autonomy — set the autonomy score --

  app.put('/api/autonomy', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const body = request.body as { score?: unknown; reason?: string };

    // Validate that score is present — reason is optional.
    if (body?.score === undefined || body.score === null) {
      return reply.status(400).send({ error: 'Request body must include a "score" field.' });
    }

    const score = body.score as number;
    const reason = body.reason;

    try {
      // Source is always 'web-ui' for changes made through this route.
      const result = await autonomyService.setScore(score, 'web-ui', reason);

      return reply.send({
        autonomy: {
          score: result.score,
          band: result.band,
          bandDescription: AutonomyService.bandDescription(result.band),
          updatedAt: result.updatedAt,
          updatedBy: result.updatedBy,
        },
        previousScore: result.previousScore,
        updated: true,
      });
    } catch (err) {
      request.log.error({ err }, 'PUT /api/autonomy: failed to set autonomy score');

      // setScore throws with this prefix for out-of-range or non-integer scores.
      // Return 400 so the UI can surface a user-friendly validation error.
      const message = err instanceof Error ? err.message : '';
      if (message.includes('Invalid autonomy score')) {
        return reply.status(400).send({ error: message });
      }

      return reply.status(500).send({ error: 'Failed to update autonomy score. Check server logs.' });
    }
  });

  // -- GET /api/autonomy/history — paginated history of score changes --

  app.get('/api/autonomy/history', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    // Parse query params with safe defaults. Clamp limit to max 50 to prevent
    // large result sets from taxing the DB on a busy instance.
    const query = request.query as { limit?: string; offset?: string };
    const rawLimit = parseInt(query.limit ?? '5', 10);
    const rawOffset = parseInt(query.offset ?? '0', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 5;
    const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

    try {
      const { rows, total } = await autonomyService.getHistoryPaginated(limit, offset);

      // Map camelCase AutonomyHistoryEntry fields directly — no transformation needed.
      const history = rows.map(entry => ({
        id: entry.id,
        score: entry.score,
        previousScore: entry.previousScore,
        band: entry.band,
        changedBy: entry.changedBy,
        reason: entry.reason,
        changedAt: entry.changedAt,
      }));

      return reply.send({ history, total });
    } catch (err) {
      request.log.error({ err }, 'GET /api/autonomy/history: failed to retrieve history');
      return reply.status(500).send({ error: 'Failed to get autonomy history. Check server logs.' });
    }
  });
}
