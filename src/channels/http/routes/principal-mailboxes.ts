// principal-mailboxes.ts — console routes for the principal's Gmail mailboxes (#2475).
//
// Under /api/registry/principal-mailboxes, covered by the /api/registry auth bypass in
// http-adapter.ts; every handler authenticates itself via assertSecret (session cookie or
// bootstrap secret), like email-accounts.ts.
//
//   GET    /                      — live mailboxes (never a grant id)
//   POST   /                      — add { id, label, grant_id, make_default? }
//   POST   /test                  — look a grant up { grant_id } -> { email, provider }; stores nothing
//   PATCH  /:id                   — { label?, make_default?, grant_id? } (grant_id: replace the
//                                    mailbox's grant with one for the same address, R29)
//   GET    /:id/removal-preview   — what removing would affect
//   DELETE /:id                   — { still_owned, new_default_id?, new_primary_email? }
//
// A grant id is accepted in request bodies only; it is never returned or logged here.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SessionStore } from '../session-auth.js';
import { assertSecret } from '../session-auth.js';
import type { PrincipalMailboxAdmin } from '../../../principal-mailboxes/admin.js';
import { MailboxRemovalError } from '../../../principal-mailboxes/admin.js';
import type { PrincipalMailboxes } from '../../../principal-mailboxes/service.js';
import type { PrincipalMailboxStore } from '../../../principal-mailboxes/store.js';
import { RemovedMailboxError, UnknownMailboxError } from '../../../principal-mailboxes/types.js';
import { grantLookupFailureDetail, grantSafeErrorFields, mayCarryGrantId } from '../../../principal-mailboxes/error-fields.js';

export interface PrincipalMailboxesRouteOptions {
  mailboxes: Pick<PrincipalMailboxes, 'list' | 'isFallbackActive' | 'pendingMigrationReason'>;
  store: Pick<PrincipalMailboxStore, 'relabel'>;
  admin: Pick<PrincipalMailboxAdmin, 'add' | 'setDefault' | 'replaceGrant' | 'removalPreview' | 'remove'>;
  /** Absent when no Nylas API key is configured: add and test then answer 503. */
  lookupGrant?: (grantId: string) => Promise<{ email: string; provider: string }>;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

const MAX_LABEL = 80;
const NO_NYLAS = 'No Nylas API key is configured. Set channel.email.nylas_api_key first.';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// Nylas v3 grant ids are UUIDs; this also admits other URL-safe ids of a sane length, and
// keeps anything else (spaces, slashes, a pasted URL) out of the vault and of Nylas requests.
const GRANT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const GRANT_ID_ERROR = 'grant_id must be a Nylas grant ID (letters, digits, - and _, 8-128 characters)';
// A label is shown in the console and in outage emails: no control characters (\p{Cc}).
const CONTROL_CHAR_RE = /\p{Cc}/u;
const labelError = (label: string): string | null =>
  !label || label.length > MAX_LABEL || CONTROL_CHAR_RE.test(label)
    ? `label must be 1-${MAX_LABEL} characters with no control characters`
    : null;

export async function principalMailboxesRoutes(
  app: FastifyInstance,
  options: PrincipalMailboxesRouteOptions,
): Promise<void> {
  const { mailboxes, store, admin, lookupGrant, webAppBootstrapSecret, sessions } = options;
  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const base = '/api/registry/principal-mailboxes';

  const requireAuth = (request: FastifyRequest, reply: FastifyReply): boolean =>
    assertSecret(request, reply, webAppBootstrapSecret, sessions);

  // Unknown / removed ids are 404; anything else is a real failure (logged, generic 500).
  function fail(request: FastifyRequest, reply: FastifyReply, err: unknown, what: string) {
    if (err instanceof UnknownMailboxError || err instanceof RemovedMailboxError) {
      return reply.status(404).send({ error: err.message });
    }
    if (err instanceof MailboxRemovalError) {
      return reply.status(422).send({ refusal: 'removal_precondition', detail: err.message });
    }
    // A Nylas error's message or own properties can carry a grant id: class and status only.
    // Store, contacts and vault errors keep their message, which the logs need.
    const fields = err instanceof Error && !mayCarryGrantId(err)
      ? { ...grantSafeErrorFields(err), errMessage: err.message }
      : grantSafeErrorFields(err);
    request.log.error(fields, `${what} failed`);
    return reply.status(500).send({ error: `${what} failed. Check server logs.` });
  }

  app.get(base, AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const list = await mailboxes.list();
      // Deferred migration: the fallback is the only entry and has no registry row yet.
      const pending = list.length > 0 && (await mailboxes.isFallbackActive());
      // Why it is still pending (operator-facing; never an address or grant id).
      const reason = pending ? mailboxes.pendingMigrationReason() : null;
      return reply.send({
        mailboxes: list.map((m) => (pending
          ? { ...m, pending_migration: true, ...(reason ? { pending_migration_reason: reason } : {}) }
          : m)),
      });
    } catch (err) {
      return fail(request, reply, err, 'Listing principal mailboxes');
    }
  });

  app.post(`${base}/test`, AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const grantId = str((request.body as { grant_id?: unknown } | null)?.grant_id);
    if (!grantId) return reply.status(400).send({ error: 'grant_id is required' });
    if (!GRANT_ID_RE.test(grantId)) return reply.status(400).send({ error: GRANT_ID_ERROR });
    if (!lookupGrant) return reply.status(503).send({ error: NO_NYLAS });
    try {
      const grant = await lookupGrant(grantId);
      return reply.send({ email: grant.email, provider: grant.provider });
    } catch (err) {
      // The grant id is deliberately not logged: class and status only.
      request.log.warn(grantSafeErrorFields(err), 'Principal mailbox grant test failed');
      return reply.status(422).send({ refusal: 'grant_unreadable', detail: grantLookupFailureDetail(err) });
    }
  });

  app.post(base, AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as { id?: unknown; label?: unknown; grant_id?: unknown; make_default?: unknown };
    const id = str(body.id);
    const label = str(body.label);
    const grantId = str(body.grant_id);
    if (!id) return reply.status(400).send({ error: 'id is required' });
    const badLabel = labelError(label);
    if (badLabel) return reply.status(400).send({ error: badLabel });
    if (!grantId) return reply.status(400).send({ error: 'grant_id is required' });
    if (!GRANT_ID_RE.test(grantId)) return reply.status(400).send({ error: GRANT_ID_ERROR });
    if (body.make_default !== undefined && typeof body.make_default !== 'boolean') {
      return reply.status(400).send({ error: 'make_default must be a boolean' });
    }
    if (!lookupGrant) return reply.status(503).send({ error: NO_NYLAS });
    try {
      const result = await admin.add({ id, label, grantId, makeDefault: body.make_default });
      if (!result.ok) return reply.status(422).send({ refusal: result.refusal, detail: result.detail });
      request.log.info({ mailboxId: id }, 'principal mailbox added');
      return reply.status(201).send({ mailbox: result.mailbox, ...(result.warning ? { warning: result.warning } : {}) });
    } catch (err) {
      return fail(request, reply, err, 'Adding the principal mailbox');
    }
  });

  app.patch(`${base}/:id`, AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { label?: unknown; make_default?: unknown; grant_id?: unknown };
    const hasLabel = body.label !== undefined;
    const hasGrant = body.grant_id !== undefined;
    const grantId = str(body.grant_id);
    if (hasGrant && !GRANT_ID_RE.test(grantId)) {
      return reply.status(400).send({ error: GRANT_ID_ERROR });
    }
    const label = str(body.label);
    const badLabel = hasLabel ? labelError(label) : null;
    if (badLabel) return reply.status(400).send({ error: badLabel });
    if (body.make_default !== undefined && body.make_default !== true) {
      return reply.status(400).send({ error: 'make_default can only be true; name another mailbox to change the default' });
    }
    // One change per request, so a failure part-way never leaves an earlier one applied
    // behind an error the caller reads as "nothing changed".
    const changes = [hasLabel, body.make_default === true, hasGrant].filter(Boolean).length;
    if (changes !== 1) {
      return reply.status(400).send({ error: 'Provide exactly one of label, make_default or grant_id' });
    }
    if (hasGrant && !lookupGrant) return reply.status(503).send({ error: NO_NYLAS });
    try {
      let warning: string | undefined;
      if (hasGrant) {
        const replaced = await admin.replaceGrant(id, grantId);
        if (!replaced.ok) return reply.status(422).send({ refusal: replaced.refusal, detail: replaced.detail });
        request.log.info({ mailboxId: id }, 'principal mailbox grant replaced');
        warning = replaced.warning;
      } else if (body.make_default === true) {
        warning = (await admin.setDefault(id)).warning;
      } else {
        await store.relabel(id, label);
      }
      // A warning means the change committed but a follow-up copy is pending: still a success.
      return reply.send({ ok: true, ...(warning ? { warning } : {}) });
    } catch (err) {
      return fail(request, reply, err, 'Updating the principal mailbox');
    }
  });

  app.get(`${base}/:id/removal-preview`, AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { id } = request.params as { id: string };
    try {
      return reply.send(await admin.removalPreview(id));
    } catch (err) {
      return fail(request, reply, err, 'Previewing the removal');
    }
  });

  app.delete(`${base}/:id`, AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { still_owned?: unknown; new_default_id?: unknown; new_primary_email?: unknown };
    if (typeof body.still_owned !== 'boolean') {
      return reply.status(400).send({ error: 'still_owned (boolean) is required' });
    }
    const newDefaultId = str(body.new_default_id) || undefined;
    const newPrimaryEmail = str(body.new_primary_email) || undefined;
    try {
      const outcome = await admin.remove({ id, stillOwned: body.still_owned, newDefaultId, newPrimaryEmail });
      // Past the tombstone the mailbox is removed: unfinished cleanup is reported, not a failure.
      if (outcome.cleanupIncomplete.length > 0) {
        request.log.warn({ mailboxId: id, cleanupIncomplete: outcome.cleanupIncomplete }, 'principal mailbox removed; some cleanup did not finish');
      } else {
        request.log.info({ mailboxId: id }, 'principal mailbox removed');
      }
      return reply.send({
        ok: true,
        removed: true,
        cleanup_incomplete: outcome.cleanupIncomplete,
        restart_required: outcome.restartRequired,
      });
    } catch (err) {
      return fail(request, reply, err, 'Removing the principal mailbox');
    }
  });
}
