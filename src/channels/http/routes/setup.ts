// setup.ts — HTTP routes for the in-app onboarding flow (issue #771).
//
// These endpoints back the wizard's new "About you" step and let the frontend
// decide which onboarding screen to land on. They are intentionally narrow:
// no general-purpose contact CRUD, no channel-identity creation — channel
// identities are bound later via the per-channel verification flows.
//
// Endpoints:
//   POST /api/setup/principal — name-only principal creation (idempotent)
//   GET  /api/setup/status    — does the system need setup? what's done so far?
//   POST /api/setup/restart   — terminate the process so the supervisor brings
//                               it back into normal (non-setup-required) mode
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
import type { InfraLlmService } from '../../../skills/infra-llm.js';
import { parseSuggestedFirstName, SUGGEST_NAME_PROMPT } from './suggest-name.js';
import type { ContactService } from '../../../contacts/contact-service.js';
import type { EntityMemory } from '../../../memory/entity-memory.js';
import { validateWorkingHours, serializeWorkingHours } from '../../../contacts/working-hours.js';

export interface SetupRouteOptions {
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  pool: Pool;
  logger: Logger;
  /** Canonical contact writes + identity linking for the principal profile step (#392). */
  contactService: ContactService;
  /** KG fact store for the principal's working-hours fact (#392). */
  entityMemory: EntityMemory | undefined;
  /**
   * Whether the process booted in setup-required mode (no principal at boot, so
   * email + Signal adapters were skipped). Captured at startup and never changes
   * over the process lifetime — a restart is required to leave setup-required mode.
   * Drives the externalAdaptersPending flag on /api/setup/status so the frontend
   * can prompt the operator to restart once they've finished the wizard.
   */
  setupRequiredAtBoot: boolean;
  /**
   * ISO timestamp captured at the start of main() in src/index.ts. Exposed on
   * GET /api/setup/status so the post-setup polling loop in the wizard can
   * distinguish "old process still dying" from "new process up" — when this
   * value changes across responses, the supervisor restart has completed.
   */
  bootStartedAt: string;
  /**
   * Triggers a process exit so the supervisor (Docker, systemd) can bring the
   * process back up in normal mode. Injected for testability — production
   * passes a small wrapper around process.exit; tests pass a spy.
   */
  scheduleProcessExit: (delayMs: number) => void;
  /**
   * Constrained LLM access used by POST /api/setup/suggest-name to propose a
   * starter first name for the assistant (issue #799). Optional: when absent
   * (e.g. no LLM provider configured) the endpoint reports "unavailable" and the
   * wizard silently keeps its static placeholder — name suggestion is a
   * nice-to-have, never a setup blocker.
   */
  infraLlmService?: InfraLlmService;
}

// Match identity.ts: tighter rate limit on auth-sensitive routes (10/min vs the
// global 200/min) so a stolen session or guessed bootstrap secret can't be
// abused at high rate. assertSecret throttling happens upstream of this on
// outright failed auth, but valid-credential abuse needs its own cap.
const AUTH_RATE = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

const MAX_DISPLAY_NAME_LENGTH = 200;

// Pragmatic address shape check — full RFC validation is unnecessary; the address is
// the principal's own and is normalized to lowercase before linking.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function setupRoutes(
  app: FastifyInstance,
  options: SetupRouteOptions,
): Promise<void> {
  const {
    webAppBootstrapSecret,
    sessions,
    pool,
    logger,
    contactService,
    entityMemory,
    setupRequiredAtBoot,
    bootStartedAt,
    scheduleProcessExit,
    infraLlmService,
  } = options;

  // Delay before process.exit so Fastify can finish flushing the 200 response.
  // 500ms is comfortably more than the bytes-on-the-wire time for a tiny JSON
  // body and well under the typical browser fetch timeout — the wizard's
  // polling loop will already be running by the time the process actually dies.
  const RESTART_EXIT_DELAY_MS = 500;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // -- POST /api/setup/principal --
  //
  // Creates the principal contact with `system_role='principal'` from a display
  // name alone. No channel identity is bound — verification flows handle that
  // later, per channel. Idempotent: a second call when the principal already
  // exists returns the existing IDs. If the submitted name differs from the
  // stored name, the contact is renamed so Step 1 can correct a typo (#392).
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
      let renamed = false;
      if (result.alreadyExisted) {
        // The principal already exists. Step 1 is no longer auto-skipped (#392), so a
        // second submit is the operator correcting the name — apply it instead of no-op'ing.
        const current = await contactService.findContactBySystemRole('principal');
        if (current && current.displayName !== trimmed) {
          await contactService.updateDisplayName(result.contactId, trimmed);
          renamed = true;
          // Best-effort: keep the KG person-node label in sync so KG browsing shows the
          // corrected name. The unique index idx_kg_nodes_unique (lower(label), type) can
          // reject the rename if another non-fact node already owns that label; that's
          // non-fatal — the contact column is the authoritative display name.
          try {
            await pool.query(
              `UPDATE kg_nodes SET label = $1, last_confirmed_at = now()
                 WHERE id = $2 AND type = 'person'`,
              [trimmed, result.kgNodeId],
            );
          } catch (kgErr) {
            logger.warn(
              { kgErr, kgNodeId: result.kgNodeId },
              'POST /api/setup/principal: KG label rename skipped (likely label collision); contact display_name still updated',
            );
          }
        }
      }
      return reply.send({
        contactId: result.contactId,
        kgNodeId: result.kgNodeId,
        alreadyExisted: result.alreadyExisted,
        renamed,
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

  // -- GET /api/setup/principal --
  //
  // Loads the principal's name + operational profile so the wizard can pre-populate
  // Steps 1 and 2 (#392). Returns { exists:false } (not 404) when no principal yet —
  // the wizard treats that as a fresh install.
  app.get('/api/setup/principal', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const principal = await contactService.findContactBySystemRole('principal');
      if (!principal) {
        return reply.send({
          exists: false, displayName: null, timezone: null,
          preferredName: null, title: null, email: null, workingHours: null,
        });
      }
      const withIdentities = await contactService.getContactWithIdentities(principal.id);
      const email = (withIdentities?.identities ?? [])
        .find((i) => i.channel === 'email' && i.verified && i.status === 'active')
        ?.channelIdentifier ?? null;

      // Working-hours fact: a 'fact' node linked to the principal's KG node whose
      // properties.attribute === 'working_hours'. Mirrors the assembler's getFacts query.
      let workingHours: string | null = null;
      if (principal.kgNodeId) {
        const facts = await pool.query<{ value: string | null }>(
          `SELECT n.properties->>'value' AS value
             FROM kg_edges e JOIN kg_nodes n ON n.id = e.target_node_id
            WHERE e.source_node_id = $1 AND e.type = 'relates_to'
              AND n.type = 'fact' AND lower(n.properties->>'attribute') = 'working_hours'
            ORDER BY n.last_confirmed_at DESC LIMIT 1`,
          [principal.kgNodeId],
        );
        workingHours = facts.rows[0]?.value ?? null;
      }

      return reply.send({
        exists: true,
        displayName: principal.displayName,
        timezone: principal.timezone ?? null,
        preferredName: principal.preferredName ?? null,
        title: principal.title ?? null,
        email,
        workingHours,
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/setup/principal: failed to load principal profile');
      return reply.status(500).send({ error: 'Failed to load principal profile. Check server logs.' });
    }
  });

  // -- POST /api/setup/principal/profile --
  //
  // Persists the principal operational profile collected in the wizard's "Your details"
  // step (#392): timezone + preferred name + title onto canonical contact columns; the
  // email as a verified ceo_stated channel identity (so index.ts resolves principalEmail
  // after the wizard-end restart); working hours as a KG fact surfaced by entity-context.
  // Requires the principal to exist (created in Step 1). Omitted optional fields are not
  // written, so a partial submit never clobbers an existing value.
  app.post('/api/setup/principal/profile', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const body = (request.body ?? {}) as {
      timezone?: unknown; email?: unknown; preferredName?: unknown;
      title?: unknown; workingHours?: unknown;
    };

    // timezone is required and must be a real IANA zone (same guard as config.ts).
    if (typeof body.timezone !== 'string' || body.timezone.trim().length === 0) {
      return reply.status(400).send({ error: 'timezone is required.' });
    }
    const timezone = body.timezone.trim();
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch (err) {
      if (err instanceof RangeError) {
        return reply.status(422).send({ error: `"${timezone}" is not a recognized IANA timezone.` });
      }
      throw err; // unexpected — propagate to the outer catch for structured logging + 500
    }

    // Optional fields — validate shape before any write.
    let email: string | undefined;
    if (body.email !== undefined && body.email !== null && body.email !== '') {
      // Trim once; also caps length before EMAIL_RE runs to avoid ReDoS — the domain
      // portion is ambiguous across '.' chars, causing quadratic backtracking on crafted
      // inputs. RFC 5321 caps email at 254 chars so this always finishes in O(1) time.
      const trimmedEmail = typeof body.email === 'string' ? body.email.trim() : '';
      if (!trimmedEmail || trimmedEmail.length > 254 || !EMAIL_RE.test(trimmedEmail)) {
        return reply.status(422).send({ error: 'email is not a valid address.' });
      }
      email = trimmedEmail.toLowerCase();
    }
    const preferredName =
      typeof body.preferredName === 'string' && body.preferredName.trim() ? body.preferredName.trim() : undefined;
    const title =
      typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;

    let workingHoursValue: string | undefined;
    if (body.workingHours !== undefined && body.workingHours !== null) {
      const wh = validateWorkingHours(body.workingHours);
      if (!wh) return reply.status(422).send({ error: 'workingHours is malformed.' });
      workingHoursValue = serializeWorkingHours(wh);
    }

    try {
      const principal = await contactService.findContactBySystemRole('principal');
      if (!principal) {
        return reply.status(409).send({ error: 'No principal exists yet — complete Step 1 first.' });
      }

      // Email first: updateContactFields validates primaryEmail against existing channel
      // identities, so the identity must be linked before primary_email is set. ceo_stated
      // is auto-verified (AUTO_VERIFIED_SOURCES), so this lands verified+active.
      // Guard against re-running the wizard with the same email: linkIdentity does a plain
      // INSERT and would hit the unique index on (channel, lower(channel_identifier)).
      if (email) {
        const existing = await contactService.getIdentitiesForContact(principal.id);
        const alreadyLinked = existing.some(
          (id) => id.channel === 'email' && id.channelIdentifier === email,
        );
        if (!alreadyLinked) {
          await contactService.linkIdentity({
            contactId: principal.id, channel: 'email', channelIdentifier: email,
            source: 'ceo_stated', verified: true,
          });
        }
      }

      // Canonical columns — only defined fields are written (updateContactFields drops
      // undefined entries, so omitted optionals are never clobbered).
      await contactService.updateContactFields(principal.id, {
        timezone,
        ...(preferredName !== undefined ? { preferredName } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(email !== undefined ? { primaryEmail: email } : {}),
      });

      // Working hours → KG fact on the principal's node. Carries properties.attribute so
      // storeFact runs contradiction detection (a wizard re-run updates, not duplicates).
      // entityMemory is optional (disabled when OPENAI_API_KEY is unset) — skip gracefully
      // rather than failing the whole profile save; timezone/email/name don't need the KG.
      if (workingHoursValue && principal.kgNodeId) {
        if (entityMemory) {
          await entityMemory.storeFact({
            entityNodeId: principal.kgNodeId,
            label: 'Working hours',
            properties: { attribute: 'working_hours', value: workingHoursValue, category: 'preference' },
            confidence: 1.0,
            decayClass: 'permanent',
            source: 'system:setup-wizard',
          });
        } else {
          // KG is unavailable (no OPENAI_API_KEY) — log and continue. The canonical
          // contact fields (timezone, email, name) are already persisted above.
          logger.warn(
            { kgNodeId: principal.kgNodeId },
            'POST /api/setup/principal/profile: working hours not persisted — entityMemory is unavailable (KG disabled)',
          );
        }
      } else if (workingHoursValue && !principal.kgNodeId) {
        // Principal exists but has no KG node yet — working hours cannot be stored
        // as a KG fact. The canonical contact fields are still persisted above.
        logger.warn(
          { contactId: principal.id },
          'POST /api/setup/principal/profile: principal has no kg_node_id, working hours not persisted',
        );
      }

      return reply.send({ ok: true });
    } catch (err) {
      logger.error({ err }, 'POST /api/setup/principal/profile: failed to persist profile');
      return reply.status(500).send({ error: 'Failed to save profile. Check server logs.' });
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
        bootStartedAt,
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/setup/status: failed to compute setup status');
      return reply.status(500).send({
        error: 'Failed to compute setup status. Check server logs.',
      });
    }
  });

  // -- POST /api/setup/restart --
  //
  // Authoritative trigger for "I've finished setup, please come back in normal
  // mode." Responds 200, then schedules a process exit so the supervisor
  // (Docker restart policy, systemd, etc.) brings the process back. The wizard
  // polls GET /api/setup/status for a different bootStartedAt + externalAdapters
  // Pending=false to know the restart has landed.
  //
  // Guarded by `setupRequiredAtBoot`: a restart triggered against an already-
  // healthy process would be a surprise side effect with no recovery story.
  // Rejecting it here makes the endpoint inert in normal operation.
  //
  // In dev (`pnpm dev`), no supervisor exists — the process will die and stay
  // dead until the developer re-runs the dev command. The wizard's polling
  // loop times out gracefully and tells them so.
  app.post('/api/setup/restart', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    if (!setupRequiredAtBoot) {
      // The process was not started in setup-required mode, so there is
      // nothing to "come back into" — a restart here would just be downtime.
      // The wizard sees this 409 and treats it as "another tab / earlier run
      // already completed setup" → it navigates to /chat instead of erroring.
      return reply.status(409).send({
        error: 'Curia is already running in normal mode; no restart is needed.',
      });
    }

    // Refuse a restart unless the setup prerequisites are actually satisfied.
    // Without this check, an authenticated caller could trigger an exit before
    // creating the principal / saving the identity; the supervisor brings the
    // process back into setup-required mode (still missing prerequisites), and
    // the cycle can repeat — pure churn that the operator can't escape via the
    // UI. The 409 is informational; the wizard does its own gating before
    // calling this endpoint, so a healthy frontend never sees this branch.
    try {
      const principalRow = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM contacts WHERE system_role = 'principal'
         ) AS exists`,
      );
      const principalExists = principalRow.rows[0]?.exists ?? false;
      const identityConfigured = await isIdentityConfigured(pool);
      if (!principalExists || !identityConfigured) {
        return reply.status(409).send({
          error: 'Setup is incomplete — create the principal and save the identity before restarting.',
          principalExists,
          identityConfigured,
        });
      }
    } catch (err) {
      logger.error({ err }, 'POST /api/setup/restart: failed to verify setup prerequisites');
      return reply.status(500).send({
        error: 'Failed to verify setup state before restart. Check server logs.',
      });
    }

    logger.warn(
      { bootStartedAt, delayMs: RESTART_EXIT_DELAY_MS },
      'POST /api/setup/restart: scheduling process exit so supervisor can bring Curia back in normal mode',
    );
    // The 200 reply has already gone out by the time the timer fires, but if
    // scheduleProcessExit itself throws synchronously, Fastify's default error
    // handler would try to send another response (and warn about it). The
    // injected wrapper today is a plain setTimeout — won't throw — but the
    // contract allows any impl. Log and proceed; the client has its 200 and
    // the polling loop's timeout is the safety net if the exit never lands.
    try {
      scheduleProcessExit(RESTART_EXIT_DELAY_MS);
    } catch (err) {
      logger.error({ err }, 'POST /api/setup/restart: scheduleProcessExit threw — restart will not occur');
    }
    return reply.send({ restarting: true, exitDelayMs: RESTART_EXIT_DELAY_MS });
  });

  // -- POST /api/setup/suggest-name --
  //
  // One-shot LLM call that proposes a starter first name for the assistant,
  // shown by the wizard's identity step (issue #799). Two purposes: a touch of
  // per-install personalization, and an early smoke test that the configured
  // Anthropic key actually works before the operator commits anything.
  //
  // Best-effort by contract: every failure mode (no LLM service, provider error,
  // an unparseable response) returns a non-2xx the frontend treats as "keep the
  // static placeholder." No error is ever surfaced to the user from here —
  // channel/key validation has its own surface later in the wizard. POST (not
  // GET) because the call costs tokens and must not be cached by the browser.
  app.post('/api/setup/suggest-name', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    if (!infraLlmService) {
      // No LLM provider wired — nothing to suggest. 503 → frontend falls back.
      return reply.status(503).send({ error: 'Name suggestion is unavailable.' });
    }

    // extract() routes to the 'standard' tier and is errors-as-values: a provider
    // failure is meant to come back as { ok: false }, never a throw. The
    // try/catch is belt-and-suspenders — an unexpected rejection (e.g. a future
    // provider impl, or a bug in the routing layer) is funneled into the same
    // controlled 502 fallback rather than bubbling up as an uncontrolled 500.
    // Cap the output hard: we only want a single word, and a tight ceiling keeps
    // the smoke test cheap.
    let result;
    try {
      result = await infraLlmService
        .scoped({ toolName: 'wizard-suggest-name', conversationId: 'setup' })
        .extract(SUGGEST_NAME_PROMPT, { maxTokens: 16 });
    } catch (err) {
      logger.warn({ err }, 'POST /api/setup/suggest-name: LLM call threw unexpectedly — frontend will fall back');
      return reply.status(502).send({ error: 'Could not generate a suggestion.' });
    }

    if (!result.ok) {
      logger.info({ error: result.error }, 'POST /api/setup/suggest-name: LLM call failed — frontend will fall back');
      return reply.status(502).send({ error: 'Could not generate a suggestion.' });
    }

    const name = parseSuggestedFirstName(result.text);
    if (!name) {
      logger.info({ raw: result.text }, 'POST /api/setup/suggest-name: response was not a clean first name — frontend will fall back');
      return reply.status(422).send({ error: 'Suggestion was not a usable name.' });
    }

    return reply.send({ name });
  });
}
