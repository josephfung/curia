// identity.ts — HTTP routes for the Office Identity API.
//
// All routes require x-web-bootstrap-secret authentication (same as the KG explorer).
// Routes are only registered when webAppBootstrapSecret is configured.
//
// Endpoints:
//   GET  /api/identity         — return the current active identity config
//   PUT  /api/identity         — save a new version and trigger hot reload
//   GET  /api/identity/history — return all versions, newest first
//   POST /api/identity/reload  — force a reload from DB (used post-wizard)

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { OfficeIdentityService } from '../../../identity/service.js';
import type { OfficeIdentity } from '../../../identity/types.js';

export interface IdentityRouteOptions {
  identityService: OfficeIdentityService;
  webAppBootstrapSecret: string;
}

/** Validate the x-web-bootstrap-secret header. Uses timing-safe comparison. */
function validateBootstrapSecret(
  provided: unknown,
  configured: string,
): boolean {
  if (typeof provided !== 'string') return false;
  if (provided.length !== configured.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
}

export async function identityRoutes(
  app: FastifyInstance,
  options: IdentityRouteOptions,
): Promise<void> {
  const { identityService, webAppBootstrapSecret } = options;

  // Auth helper — validates the bootstrap secret on every request to these routes.
  function requireBootstrapSecret(
    headers: Record<string, string | string[] | undefined>,
    reply: FastifyReply,
  ): boolean {
    const provided = headers['x-web-bootstrap-secret'];
    if (!validateBootstrapSecret(provided, webAppBootstrapSecret)) {
      void reply.status(401).send({
        error: 'Unauthorized. Provide a valid x-web-bootstrap-secret header.',
      });
      return false;
    }
    return true;
  }

  // -- GET /api/identity — return current identity config --

  app.get('/api/identity', async (request, reply) => {
    if (!requireBootstrapSecret(request.headers as Record<string, string | string[] | undefined>, reply)) return;

    try {
      const identity = identityService.get();
      return reply.send({ identity });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get identity';
      return reply.status(500).send({ error: message });
    }
  });

  // -- PUT /api/identity — save a new version and trigger hot reload --

  app.put('/api/identity', async (request, reply) => {
    if (!requireBootstrapSecret(request.headers as Record<string, string | string[] | undefined>, reply)) return;

    const body = request.body as {
      identity?: OfficeIdentity;
      note?: string;
    };

    if (!body?.identity) {
      return reply.status(400).send({ error: 'Request body must include an "identity" object' });
    }

    try {
      await identityService.update(body.identity, 'api', body.note);
      const updated = identityService.get();
      return reply.send({ identity: updated, updated: true });
    } catch (err) {
      // Validation errors from validateIdentity() are plain Error instances with descriptive
      // messages — return 400 so the wizard UI can surface them to the user.
      // DB / infrastructure errors carry a Postgres error code — return 500.
      const pgCode = (err as { code?: string }).code;
      if (pgCode !== undefined) {
        return reply.status(500).send({ error: 'Failed to save identity due to a server error. Check server logs.' });
      }
      const message = err instanceof Error ? err.message : 'Failed to update identity';
      return reply.status(400).send({ error: message });
    }
  });

  // -- GET /api/identity/history — return all versions, newest first --

  app.get('/api/identity/history', async (request, reply) => {
    if (!requireBootstrapSecret(request.headers as Record<string, string | string[] | undefined>, reply)) return;

    try {
      const history = await identityService.history();
      return reply.send({ history });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get identity history';
      return reply.status(500).send({ error: message });
    }
  });

  // -- POST /api/identity/reload — force a reload from DB --
  // Used by the wizard after saving, to ensure the latest DB version is reflected
  // in the in-memory cache before the next coordinator turn.

  app.post('/api/identity/reload', async (request, reply) => {
    if (!requireBootstrapSecret(request.headers as Record<string, string | string[] | undefined>, reply)) return;

    try {
      await identityService.reload();
      const identity = identityService.get();
      return reply.send({ identity, reloaded: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reload identity';
      return reply.status(500).send({ error: message });
    }
  });
}
