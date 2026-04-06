// identity.ts — HTTP routes for the Office Identity API.
//
// All routes require session cookie or x-web-bootstrap-secret authentication
// (same as the KG explorer). Routes are only registered when webAppBootstrapSecret
// is configured.
//
// Endpoints:
//   GET  /api/identity         — return the current active identity config + configured flag
//   PUT  /api/identity         — save a new version and trigger hot reload
//   GET  /api/identity/history — return all versions, newest first
//   POST /api/identity/reload  — force a reload from DB (used post-wizard)

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { OfficeIdentityService } from '../../../identity/service.js';
import type { OfficeIdentity } from '../../../identity/types.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface IdentityRouteOptions {
  identityService: OfficeIdentityService;
  webAppBootstrapSecret: string;
  // Shared session store from HttpAdapter — allows browser sessions (cookie auth)
  // to call identity routes without the raw bootstrap secret being stored in JS.
  sessions: SessionStore;
  // Required for the configured flag query on GET /api/identity.
  pool: Pool;
}

export async function identityRoutes(
  app: FastifyInstance,
  options: IdentityRouteOptions,
): Promise<void> {
  const { identityService, webAppBootstrapSecret, sessions, pool } = options;

  // Auth helper — validates session cookie or bootstrap secret on every request.
  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // -- GET /api/identity — return current identity config --

  app.get('/api/identity', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const identity = identityService.get();

      // Determine whether the identity has ever been explicitly configured via the wizard
      // or API. A fresh deployment (only file_load versions) returns configured: false,
      // which triggers the first-run wizard in the browser.
      const configuredResult = await pool.query<{ configured: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM office_identity_versions
           WHERE changed_by IN ('wizard', 'api')
         ) AS configured`,
      );
      const configured = configuredResult.rows[0]?.configured ?? false;

      return reply.send({ identity, configured });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get identity';
      return reply.status(500).send({ error: message });
    }
  });

  // -- PUT /api/identity — save a new version and trigger hot reload --

  app.put('/api/identity', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const body = request.body as {
      identity?: OfficeIdentity;
      note?: string;
    };

    if (!body?.identity) {
      return reply.status(400).send({ error: 'Request body must include an "identity" object' });
    }

    // @TODO: The constraints field in the identity object is currently not protected —
    // callers can omit or alter constraints, weakening the non-negotiable rules.
    // The wizard PR will enforce constraint immutability via a separate UI flow
    // (explicit confirmation step, separate from tone/persona edits).

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
    if (!requireAuth(request, reply)) return;

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
    if (!requireAuth(request, reply)) return;

    try {
      await identityService.reload();
      const identity = identityService.get();
      return reply.send({ identity, reloaded: true });
    } catch {
      // Do not forward the error message — reload failures surface DB internals (table names,
      // migration identifiers, constraint names) that should not reach API callers.
      // The error is already logged by reload() before rethrowing.
      return reply.status(500).send({ error: 'Failed to reload identity due to a server error. Check server logs.' });
    }
  });
}
