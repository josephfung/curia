// principal-mailboxes.ts — console routes for the principal's Gmail mailboxes (#2475).
//
// Under /api/registry/principal-mailboxes, covered by the /api/registry auth bypass in
// http-adapter.ts; every handler authenticates itself via assertSecret (session cookie or
// bootstrap secret), like email-accounts.ts.
//
//   GET    /                      — live mailboxes (never a grant id)
//   POST   /                      — add { id, label, grant_id, make_default? }
//   POST   /test                  — look a grant up { grant_id } -> { email, provider }; stores nothing
//   PATCH  /:id                   — { label?, make_default? }
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

export interface PrincipalMailboxesRouteOptions {
  mailboxes: Pick<PrincipalMailboxes, 'list' | 'isFallbackActive'>;
  store: Pick<PrincipalMailboxStore, 'relabel'>;
  admin: Pick<PrincipalMailboxAdmin, 'add' | 'setDefault' | 'removalPreview' | 'remove'>;
  /** Absent when no Nylas API key is configured: add and test then answer 503. */
  lookupGrant?: (grantId: string) => Promise<{ email: string; provider: string }>;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

const MAX_LABEL = 80;
const NO_NYLAS = 'No Nylas API key is configured. Set channel.email.nylas_api_key first.';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

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
    // Only the class name: an upstream error's message or stack can carry a grant id.
    request.log.error({ errName: err instanceof Error ? err.name : 'unknown' }, `${what} failed`);
    return reply.status(500).send({ error: `${what} failed. Check server logs.` });
  }

  app.get(base, AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const list = await mailboxes.list();
      // Deferred migration: the fallback is the only entry and has no registry row yet.
      const pending = list.length > 0 && (await mailboxes.isFallbackActive());
      return reply.send({ mailboxes: list.map((m) => (pending ? { ...m, pending_migration: true } : m)) });
    } catch (err) {
      return fail(request, reply, err, 'Listing principal mailboxes');
    }
  });

  app.post(`${base}/test`, AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const grantId = str((request.body as { grant_id?: unknown } | null)?.grant_id);
    if (!grantId) return reply.status(400).send({ error: 'grant_id is required' });
    if (!lookupGrant) return reply.status(503).send({ error: NO_NYLAS });
    try {
      const grant = await lookupGrant(grantId);
      return reply.send({ email: grant.email, provider: grant.provider });
    } catch (err) {
      // The grant id is deliberately not logged.
      request.log.warn({ errName: err instanceof Error ? err.name : 'unknown' }, 'Principal mailbox grant test failed');
      return reply.status(422).send({ refusal: 'grant_unreadable', detail: 'The grant could not be read from Nylas' });
    }
  });

  app.post(base, AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as { id?: unknown; label?: unknown; grant_id?: unknown; make_default?: unknown };
    const id = str(body.id);
    const label = str(body.label);
    const grantId = str(body.grant_id);
    if (!id) return reply.status(400).send({ error: 'id is required' });
    if (!label || label.length > MAX_LABEL) return reply.status(400).send({ error: `label is required (at most ${MAX_LABEL} characters)` });
    if (!grantId) return reply.status(400).send({ error: 'grant_id is required' });
    if (body.make_default !== undefined && typeof body.make_default !== 'boolean') {
      return reply.status(400).send({ error: 'make_default must be a boolean' });
    }
    if (!lookupGrant) return reply.status(503).send({ error: NO_NYLAS });
    try {
      const result = await admin.add({ id, label, grantId, makeDefault: body.make_default });
      if (!result.ok) return reply.status(422).send({ refusal: result.refusal, detail: result.detail });
      request.log.info({ mailboxId: id }, 'principal mailbox added');
      return reply.status(201).send({ mailbox: result.mailbox });
    } catch (err) {
      return fail(request, reply, err, 'Adding the principal mailbox');
    }
  });

  app.patch(`${base}/:id`, AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { label?: unknown; make_default?: unknown };
    const hasLabel = body.label !== undefined;
    const label = str(body.label);
    if (hasLabel && (!label || label.length > MAX_LABEL)) {
      return reply.status(400).send({ error: `label must be 1-${MAX_LABEL} characters` });
    }
    if (body.make_default !== undefined && body.make_default !== true) {
      return reply.status(400).send({ error: 'make_default can only be true; name another mailbox to change the default' });
    }
    if (!hasLabel && body.make_default !== true) {
      return reply.status(400).send({ error: 'Provide label and/or make_default' });
    }
    try {
      // Default first: it is the step that can refuse; the relabel is harmless to repeat.
      if (body.make_default === true) await admin.setDefault(id);
      if (hasLabel) await store.relabel(id, label);
      return reply.send({ ok: true });
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
      await admin.remove({ id, stillOwned: body.still_owned, newDefaultId, newPrimaryEmail });
      request.log.info({ mailboxId: id }, 'principal mailbox removed');
      return reply.send({ ok: true });
    } catch (err) {
      return fail(request, reply, err, 'Removing the principal mailbox');
    }
  });
}
