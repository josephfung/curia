// identity.ts — HTTP routes for the Office Identity API.
//
// All routes require session cookie or x-web-bootstrap-secret authentication
// (same as the KG explorer). Routes are only registered when webAppBootstrapSecret
// is configured.
//
// Endpoints:
//   GET  /api/identity         — the current identity config, configured flag, and the
//                                 Detail slider's per-channel length limits
//   PUT  /api/identity         — save a new version and trigger hot reload
//   GET  /api/identity/history — return all versions, newest first
//   POST /api/identity/reload  — force a reload from DB (used post-wizard)

import { isInSetup, readSetupState } from '../../../setup/setup-settings.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { OfficeIdentityService } from '../../../identity/service.js';
import type { OfficeIdentity } from '../../../identity/types.js';
import { DETAIL_BANDS, LENGTH_ROWS, LENGTH_ROW_LABELS } from '../../../identity/length.js';

/**
 * The Detail slider's per-channel limits, for the console's preview (#2143). The same
 * table the identity block renders, so a calibration changes one place.
 */
export const LENGTH_LIMITS_RESPONSE = {
  rows: LENGTH_ROWS.map(id => ({ id, label: LENGTH_ROW_LABELS[id] })),
  bands: DETAIL_BANDS,
};
import { assertSecret, CONSOLE_RATE, type SessionStore } from '../session-auth.js';

/**
 * Returns true if the office identity has ever been explicitly configured via the
 * wizard or API. A fresh deployment only has file_load versions and returns false.
 * A 'working_style' save (the Setup page's tone, #2358) doesn't count: it sets no name,
 * so it must not tick Curia's name, the Setup step this answers.
 *
 * Shared with the /api/setup/status route so both endpoints answer the same question
 * the same way; "configured" is a single concept, not a per-route opinion.
 */
export async function isIdentityConfigured(pool: Pick<Pool, 'query'> | PoolClient): Promise<boolean> {
  const result = await pool.query<{ configured: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM office_identity_versions
       WHERE changed_by IN ('wizard', 'api')
     ) AS configured`,
  );
  return result.rows[0]?.configured ?? false;
}

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

  // Stricter per-route rate limit for all identity endpoints: 10 req/min per IP.
  // These routes check credentials on every call — a brute-force target that
  // needs tighter throttling than the global 200/min baseline.
  const AUTH_RATE = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  // Reads use the console-wide read limit (60/min): the router reads GET /api/identity on every
  // navigation, and the Setup page re-reads after each save. Failed auth is throttled
  // separately, in assertSecret, so a tight cap on authenticated reads only adds friction
  // (#2358). Writes keep AUTH_RATE.

  // -- GET /api/identity — return current identity config --

  app.get('/api/identity', CONSOLE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const identity = identityService.get();

      // Determine whether the identity has ever been explicitly configured via the wizard
      // or API. A fresh deployment (only file_load versions) returns configured: false,
      // which triggers the first-run wizard in the browser.
      const configured = await isIdentityConfigured(pool);
      // #2358: the console's first-load gate. True on a new install until Setup is finished;
      // migration 132 marked installs that predate the Setup page complete.
      const inSetup = isInSetup((await readSetupState(pool, request.log)).phase);

      return reply.send({ identity, configured, inSetup, lengthLimits: LENGTH_LIMITS_RESPONSE });
    } catch (err) {
      request.log.error({ err }, 'GET /api/identity: failed to query configured flag or get identity');
      return reply.status(500).send({ error: 'Failed to get identity. Check server logs.' });
    }
  });

  // -- PUT /api/identity — save a new version and trigger hot reload --

  app.put('/api/identity', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const body = request.body as {
      identity?: OfficeIdentity;
      changedBy?: string;
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
      // Accept 'wizard', 'api' or 'working_style' (the Setup page's tone, which
      // isIdentityConfigured doesn't count) as the source; default to 'api' for direct API callers.
      const VALID_CHANGED_BY = ['api', 'wizard', 'working_style'] as const;
      type ChangedBy = typeof VALID_CHANGED_BY[number];
      const changedBy: ChangedBy = VALID_CHANGED_BY.includes(body.changedBy as ChangedBy)
        ? (body.changedBy as ChangedBy)
        : 'api';
      await identityService.update(body.identity, changedBy, body.note);
      const updated = identityService.get();
      return reply.send({ identity: updated, updated: true });
    } catch (err) {
      request.log.error({ err }, 'PUT /api/identity: update failed');
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

  app.get('/api/identity/history', CONSOLE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const history = await identityService.history();
      return reply.send({ history });
    } catch (err) {
      request.log.error({ err }, 'GET /api/identity/history: failed to retrieve history');
      return reply.status(500).send({ error: 'Failed to get identity history. Check server logs.' });
    }
  });

  // -- POST /api/identity/reload — force a reload from DB --
  // Used by the wizard after saving, to ensure the latest DB version is reflected
  // in the in-memory cache before the next coordinator turn.

  app.post('/api/identity/reload', AUTH_RATE, async (request, reply) => {
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
