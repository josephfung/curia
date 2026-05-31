// setup.ts — HTTP routes for the in-app onboarding flow (issue #771).
//
// These endpoints back the wizard's new "About you" step and let the frontend
// decide which onboarding screen to land on. They are intentionally narrow:
// no general-purpose contact CRUD, no channel-identity creation — that's the
// job of bootstrapCeoContact (env-var bootstrap) and the future per-channel
// verification flows respectively.
//
// Endpoints:
//   POST /api/setup/principal — name-only principal creation (idempotent)
//   GET  /api/setup/status    — does the system need setup? what's done so far?
//
// All routes require session cookie or x-web-bootstrap-secret authentication
// (same pattern as identity routes). Routes are only registered when
// webAppBootstrapSecret is configured.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from '../../../logger.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { ensurePrincipalContact } from '../../../contacts/ensure-principal.js';
import { isIdentityConfigured } from './identity.js';

export interface SetupRouteOptions {
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  pool: Pool;
  logger: Logger;
  /**
   * Whether the process booted in setup-required mode (no principal at boot, so
   * email + Signal adapters were skipped). Captured at startup and never changes
   * over the process lifetime — a restart is required to leave setup-required mode.
   * Drives the externalAdaptersPending flag on /api/setup/status so the frontend
   * can prompt the operator to restart once they've finished the wizard.
   */
  setupRequiredAtBoot: boolean;
}

// Match identity.ts: tighter rate limit on auth-sensitive routes (10/min vs the
// global 200/min) so a stolen session or guessed bootstrap secret can't be
// abused at high rate. assertSecret throttling happens upstream of this on
// outright failed auth, but valid-credential abuse needs its own cap.
const AUTH_RATE = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

const MAX_DISPLAY_NAME_LENGTH = 200;

export async function setupRoutes(
  app: FastifyInstance,
  options: SetupRouteOptions,
): Promise<void> {
  const { webAppBootstrapSecret, sessions, pool, logger, setupRequiredAtBoot } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // -- POST /api/setup/principal --
  //
  // Creates the principal contact with `system_role='principal'` from a display
  // name alone. No channel identity is bound — verification flows handle that
  // later, per channel. Idempotent: a second call when the principal already
  // exists returns the existing IDs and does not rename.
  app.post('/api/setup/principal', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const body = request.body as { name?: unknown };
    const rawName = body?.name;
    if (typeof rawName !== 'string') {
      return reply.status(400).send({ error: 'Request body must include a "name" string.' });
    }
    const trimmed = rawName.trim();
    if (trimmed.length === 0) {
      return reply.status(400).send({ error: 'Name must not be empty.' });
    }
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      return reply.status(400).send({
        error: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`,
      });
    }

    try {
      const result = await ensurePrincipalContact({ displayName: trimmed }, pool, logger);
      return reply.send({
        contactId: result.contactId,
        kgNodeId: result.kgNodeId,
        alreadyExisted: result.alreadyExisted,
      });
    } catch (err) {
      logger.error({ err }, 'POST /api/setup/principal: failed to ensure principal contact');
      // Do not propagate the error message: it may include DB internals (constraint
      // names, table identifiers). The helper logs detail before throwing.
      return reply.status(500).send({
        error: 'Failed to create principal contact. Check server logs.',
      });
    }
  });

  // -- GET /api/setup/status --
  //
  // Source of truth for the frontend router's "which setup screen?" decision.
  // Three booleans, each independently checkable:
  //   - principalExists: a contact with system_role='principal' is present
  //   - identityConfigured: office_identity has been saved via wizard or API
  //   - externalAdaptersPending: the process is currently running in
  //     setup-required mode AND both prerequisites are now satisfied — i.e.
  //     the operator has finished the wizard but the email/Signal adapters
  //     remain skipped until restart. This is the signal for the dashboard
  //     "please restart" banner.
  app.get('/api/setup/status', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const principalRow = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM contacts WHERE system_role = 'principal'
         ) AS exists`,
      );
      const principalExists = principalRow.rows[0]?.exists ?? false;
      const identityConfigured = await isIdentityConfigured(pool);
      const externalAdaptersPending =
        setupRequiredAtBoot && principalExists && identityConfigured;

      return reply.send({
        principalExists,
        identityConfigured,
        externalAdaptersPending,
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/setup/status: failed to compute setup status');
      return reply.status(500).send({
        error: 'Failed to compute setup status. Check server logs.',
      });
    }
  });
}
