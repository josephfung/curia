// contacts.ts — contact CRUD, identities, overrides, merge, and grant recommendations.
//
// Moved off /api/kg/* (#872). Also relocates GET /api/grant-recommendations (was
// /api/kg/grant-recommendations) — contacts-adjacent, not a graph primitive.
// Auth: session cookie or x-web-bootstrap-secret via assertSecret.

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from '../../../logger.js';
import type { ContactService } from '../../../contacts/contact-service.js';
import { ContactValidationError, PRINCIPAL_PROMPT_FIELDS } from '../../../contacts/contact-service.js';
import type { ChannelIdentity, Contact, ContactCanonicalFields, ContactKind, ContactTier, IdentityStatus } from '../../../contacts/types.js';
import {
  IdentityNotFoundError,
  ContactNotFoundError,
  StructuralContactMergeError,
} from '../../../contacts/types.js';
import { LINKABLE_CHANNEL_IDENTITY_SET } from '../../../contacts/linkable-channels.js';
import { assertSecret, CONSOLE_RATE, type SessionStore } from '../session-auth.js';
import { isUuid } from '../../../util/uuid.js';

export interface ContactRouteOptions {
  pool: Pool;
  logger: Logger;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
  contactService: ContactService;
}

export async function contactRoutes(
  app: FastifyInstance,
  options: ContactRouteOptions,
): Promise<void> {
  const { pool, logger, webAppBootstrapSecret, sessions, contactService } = options;

  // tier/kind selectable via the API — 'principal' and kind∈{principal,agent} are structural-only.
  const validContactTiers: ContactTier[] = ['blocked', 'unknown', 'known', 'trusted'];
  const validContactKinds: ContactKind[] = ['person', 'organization', 'automated'];
  // Serialize a Contact object to the HTTP response shape.
  // Returns all canonical fields so the Console UI can display them
  // without a separate detail fetch.
  function serializeContact(c: Contact) {
    return {
      id: c.id,
      kgNodeId: c.kgNodeId,
      displayName: c.displayName,
      role: c.role,
      // Capability axis (issue #945) — the legacy status/trust_level fields were removed in #955.
      tier: c.tier,
      kind: c.kind,
      systemRole: c.systemRole,
      notes: c.notes,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      // Canonical fields (migration 048)
      preferredName: c.preferredName,
      title: c.title,
      organization: c.organization,
      primaryEmail: c.primaryEmail,
      primaryPhone: c.primaryPhone,
      timezone: c.timezone,
      locale: c.locale,
      location: c.location,
      pronouns: c.pronouns,
      linkedinUrl: c.linkedinUrl,
      bio: c.bio,
      birthday: c.birthday,
    };
  }

  // Serialize a channel identity for the API: Date fields → ISO strings, so the
  // contacts View drawer (#1069) can render them. Mirrors serializeContact above.
  function serializeIdentity(i: ChannelIdentity) {
    return {
      id: i.id,
      contactId: i.contactId,
      channel: i.channel,
      channelIdentifier: i.channelIdentifier,
      label: i.label,
      verified: i.verified,
      verifiedAt: i.verifiedAt ? i.verifiedAt.toISOString() : null,
      status: i.status,
      source: i.source,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    };
  }

  // Validate canonical fields from a POST/PATCH body.
  // Returns an error string if invalid, or null if all checks pass.
  // `fields` entries are trimmed and empty-string-coerced to null.
  function extractAndValidateCanonicalFields(body: Record<string, unknown>): {
    error: string | null;
    fields: ContactCanonicalFields;
  } {
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

    const fields: ContactCanonicalFields = {};

    // Reject non-string, non-nullish values — the str() helper would silently coerce
    // them to null, which would erase existing data on PATCH.
    const CANONICAL_STRING_KEYS = [
      'preferredName', 'title', 'organization', 'primaryPhone', 'timezone', 'locale',
      'location', 'pronouns', 'birthday', 'linkedinUrl', 'bio', 'primaryEmail',
    ] as const;
    const badKey = CANONICAL_STRING_KEYS.find(
      k => k in body && body[k] !== null && body[k] !== undefined && typeof body[k] !== 'string',
    );
    if (badKey) {
      return { error: `${badKey} must be a string or null.`, fields };
    }

    if ('preferredName' in body) fields.preferredName = str(body.preferredName);
    if ('title' in body) fields.title = str(body.title);
    if ('organization' in body) fields.organization = str(body.organization);
    if ('primaryPhone' in body) fields.primaryPhone = str(body.primaryPhone);
    if ('timezone' in body) fields.timezone = str(body.timezone);
    if ('locale' in body) fields.locale = str(body.locale);
    if ('location' in body) fields.location = str(body.location);
    if ('pronouns' in body) fields.pronouns = str(body.pronouns);
    if ('birthday' in body) fields.birthday = str(body.birthday);
    if ('linkedinUrl' in body) fields.linkedinUrl = str(body.linkedinUrl);
    if ('bio' in body) fields.bio = str(body.bio);
    if ('primaryEmail' in body) fields.primaryEmail = str(body.primaryEmail);

    // Format validation
    // Domain labels exclude '.' so the repeated atom and the literal '.' don't
    // overlap — this keeps matching linear and avoids the polynomial-time
    // backtracking (ReDoS) the previous `[^@\s]+\.[^@\s]+` form allowed on
    // attacker-controlled input. See CodeQL alert js/polynomial-redos (#96).
    if (fields.primaryEmail != null && !/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(fields.primaryEmail)) {
      return { error: 'Invalid primaryEmail format.', fields };
    }
    if (fields.linkedinUrl != null && !/^https?:\/\/(www\.)?linkedin\.com\//.test(fields.linkedinUrl)) {
      return { error: 'linkedinUrl must be a linkedin.com URL (e.g. https://linkedin.com/in/…).', fields };
    }
    if (fields.primaryPhone != null && !/^\+[1-9]\d{6,14}$/.test(fields.primaryPhone)) {
      return { error: 'primaryPhone must be in E.164 format (e.g. +15551234567).', fields };
    }
    if (fields.locale != null && !/^[a-z]{2,3}(-[A-Z]{2,4})?$/.test(fields.locale)) {
      return { error: 'locale must be a BCP 47 code (e.g. en-US, fr, zh-Hans).', fields };
    }
    if (fields.bio != null && fields.bio.length > 500) {
      return { error: 'bio must be 500 characters or fewer.', fields };
    }
    if (fields.birthday != null &&
        !/^\d{4}-\d{2}-\d{2}$/.test(fields.birthday) &&
        !/^--\d{2}-\d{2}$/.test(fields.birthday)) {
      return { error: 'birthday must be YYYY-MM-DD or --MM-DD.', fields };
    }

    return { error: null, fields };
  }

  app.get('/api/contacts', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      const contacts = await contactService.listContacts();
      return reply.send({
        contacts: contacts.map(serializeContact),
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/contacts failed');
      return reply.status(500).send({ error: 'Failed to load contacts' });
    }
  });

  app.post('/api/contacts', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const body = request.body as {
      displayName?: unknown;
      role?: unknown;
      tier?: unknown;
      kind?: unknown;
      notes?: unknown;
      kgNodeId?: unknown;
    };

    if (typeof body.displayName !== 'string' || body.displayName.trim().length === 0) {
      return reply.status(400).send({ error: 'displayName is required.' });
    }
    if (body.tier !== undefined &&
        (typeof body.tier !== 'string' || !validContactTiers.includes(body.tier as ContactTier))) {
      return reply.status(400).send({ error: `Invalid tier. Must be one of: ${validContactTiers.join(', ')}.` });
    }
    if (body.kind !== undefined &&
        (typeof body.kind !== 'string' || !validContactKinds.includes(body.kind as ContactKind))) {
      return reply.status(400).send({ error: `Invalid kind. Must be one of: ${validContactKinds.join(', ')}.` });
    }

    const kgNodeId =
      typeof body.kgNodeId === 'string' && body.kgNodeId.trim().length > 0
        ? body.kgNodeId.trim()
        : undefined;
    if (kgNodeId && !isUuid(kgNodeId)) {
      return reply.status(400).send({ error: 'Invalid kgNodeId: must be a valid UUID.' });
    }

    const { error: canonicalError, fields: canonicalFields } = extractAndValidateCanonicalFields(body as Record<string, unknown>);
    if (canonicalError) {
      return reply.status(400).send({ error: canonicalError });
    }

    let created;
    try {
      created = await contactService.createContact({
        displayName: body.displayName,
        role: typeof body.role === 'string' && body.role.trim().length > 0 ? body.role : undefined,
        notes: typeof body.notes === 'string' && body.notes.trim().length > 0 ? body.notes : undefined,
        kgNodeId,
        source: 'kg_web_ui',
        ...canonicalFields,
      });
    } catch (err) {
      // e.g. an unrecognized timezone typed into the free-text field: the operator's input
      // to fix, not a server fault. Anything else propagates to the default 500 handler.
      if (err instanceof ContactValidationError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }

    // Read back so tier/kind overrides below start from the current contact state.
    let freshCreated = await contactService.getContact(created.id);
    if (!freshCreated) {
      // Should never happen — contact was just created — but guard rather than return stale data.
      logger.error({ contactId: created.id }, 'POST /api/contacts: contact not found after creation');
      return reply.status(500).send({ error: 'Contact created but could not be retrieved.' });
    }

    // Apply tier/kind overrides atomically — one write prevents partial state if either fails.
    if (typeof body.tier === 'string' || typeof body.kind === 'string') {
      let enriched: Contact = { ...freshCreated, updatedAt: new Date() };
      if (typeof body.tier === 'string') enriched = { ...enriched, tier: body.tier as ContactTier };
      if (typeof body.kind === 'string') enriched = { ...enriched, kind: body.kind as ContactKind };
      freshCreated = await contactService.saveContact(enriched);
    }

    return reply.status(201).send({
      contact: serializeContact(freshCreated),
    });
  });

  app.patch('/api/contacts/:id', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    const body = request.body as {
      displayName?: unknown;
      role?: unknown;
      tier?: unknown;
      kind?: unknown;
      notes?: unknown;
      kgNodeId?: unknown;
    };
    const contact = await contactService.getContact(id);
    if (!contact) {
      return reply.status(404).send({ error: 'Contact not found.' });
    }

    // Validate all inputs before any mutations to avoid partial writes on bad input.
    // Validate tier — rejects 'principal' (structural, derived from system_role).
    if ('tier' in body) {
      if (typeof body.tier !== 'string' || !validContactTiers.includes(body.tier as ContactTier)) {
        return reply.status(400).send({ error: `Invalid tier. Must be one of: ${validContactTiers.join(', ')}.` });
      }
      // Principal contacts cannot be demoted or re-typed via the API.
      if (contact.systemRole === 'principal') {
        return reply.status(400).send({ error: 'The principal contact\'s tier cannot be changed via the API.' });
      }
    }
    // Validate kind — rejects 'principal' and 'agent' (structural).
    if ('kind' in body) {
      if (typeof body.kind !== 'string' || !validContactKinds.includes(body.kind as ContactKind)) {
        return reply.status(400).send({ error: `Invalid kind. Must be one of: ${validContactKinds.join(', ')}.` });
      }
      if (contact.systemRole === 'principal' || contact.systemRole === 'agent') {
        return reply.status(400).send({ error: 'The kind of a system contact (principal or agent) cannot be changed via the API.' });
      }
    }
    // Trim once; collapse whitespace-only strings to null so they don't reach the DB as invalid UUIDs.
    const normalizedKgNodeId: string | null | undefined =
      typeof body.kgNodeId === 'string'
        ? (body.kgNodeId.trim() || null)
        : body.kgNodeId === null
        ? null
        : undefined;
    if (typeof normalizedKgNodeId === 'string' && !isUuid(normalizedKgNodeId)) {
      return reply.status(400).send({ error: 'Invalid kgNodeId: must be a valid UUID.' });
    }

    const { error: canonicalError, fields: canonicalFields } = extractAndValidateCanonicalFields(body as Record<string, unknown>);
    if (canonicalError) {
      return reply.status(400).send({ error: canonicalError });
    }

    // Validate primaryEmail against CCI before any mutations so a bad value can never
    // produce partial writes (other fields committed, response still 400).
    if (canonicalFields.primaryEmail != null) {
      try {
        await contactService.validatePrimaryEmail(id, canonicalFields.primaryEmail);
      } catch (err) {
        if (err instanceof ContactValidationError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    }

    // Build the complete updated contact in memory. All field changes are merged
    // here so the transaction only needs one write — avoids non-transactional stale
    // reads that occur when individual per-field setters each load the contact.
    // `changed` tracks whether any recognized mutable field was actually supplied: a
    // PATCH carrying only ignored/legacy fields (e.g. `status`) or nothing recognized
    // must NOT bump `updatedAt` or perform a write, which would emit a false
    // "contact updated" and burn a needless transaction.
    let pending: Contact = { ...contact };
    let changed = false;

    if (typeof body.displayName === 'string' && body.displayName.trim().length > 0) {
      pending = { ...pending, displayName: body.displayName.trim() };
      changed = true;
    }
    if (typeof body.role === 'string') {
      pending = { ...pending, role: body.role };
      changed = true;
    } else if (body.role === null) {
      pending = { ...pending, role: null };
      changed = true;
    }
    if (typeof body.tier === 'string') {
      pending = { ...pending, tier: body.tier as ContactTier };
      changed = true;
    }
    if (typeof body.kind === 'string') {
      pending = { ...pending, kind: body.kind as ContactKind };
      changed = true;
    }
    if (body.notes !== undefined) {
      pending = { ...pending, notes: typeof body.notes === 'string' ? body.notes : null };
      changed = true;
    }
    if (normalizedKgNodeId !== undefined) {
      pending = { ...pending, kgNodeId: normalizedKgNodeId };
      changed = true;
    }
    const CANONICAL_KEYS: Array<keyof typeof canonicalFields> = [
      'preferredName', 'title', 'organization', 'primaryEmail', 'primaryPhone',
      'timezone', 'locale', 'location', 'pronouns', 'linkedinUrl', 'bio', 'birthday',
    ];
    const hasCanonicalFields = CANONICAL_KEYS.some(k => k in (body as Record<string, unknown>));
    if (hasCanonicalFields) {
      const definedFields = Object.fromEntries(
        Object.entries(canonicalFields).filter(([, value]) => value !== undefined),
      ) as ContactCanonicalFields;
      if (Object.keys(definedFields).length > 0) {
        if (definedFields.primaryEmail != null) {
          definedFields.primaryEmail = definedFields.primaryEmail.toLowerCase();
        }
        pending = { ...pending, ...definedFields };
        changed = true;
      }
    }

    // No recognized mutable field changed — return the current contact without a
    // spurious write or `updatedAt` bump (true no-op PATCH).
    if (!changed) {
      return reply.send({ contact: serializeContact(contact) });
    }
    pending = { ...pending, updatedAt: new Date() };

    // All remaining mutations are wrapped in a single DB transaction for atomicity.
    // saveContact applies display-name sanitization and writes all fields in one UPDATE.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await contactService.saveContact(pending, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err instanceof ContactValidationError) {
        return reply.status(400).send({ error: err.message });
      }
      request.log.error({ err }, 'contacts: PATCH mutation failed');
      return reply.status(500).send({ error: 'An error occurred while updating the contact.' });
    } finally {
      client.release();
    }

    const updated = await contactService.getContact(id);
    if (!updated) {
      return reply.status(404).send({ error: 'Contact not found after update.' });
    }
    // The columns are committed above. Identity mutations notify on their own; these
    // do not, and the prompt block reads primary_email (#1950) and the profile fields
    // (#2226): the canonical ones and the display name.
    const touchesPromptBlock =
      PRINCIPAL_PROMPT_FIELDS.some((key) => canonicalFields[key] !== undefined)
      || (typeof body.displayName === 'string' && body.displayName.trim().length > 0);
    if (updated.systemRole === 'principal' && touchesPromptBlock) {
      contactService.notePrimaryEmailChanged(updated.id);
    }
    return reply.send({
      contact: serializeContact(updated),
    });
  });

  app.delete('/api/contacts/:id', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    const contact = await contactService.getContact(id);
    if (!contact) {
      return reply.status(404).send({ error: 'Contact not found.' });
    }
    await pool.query('DELETE FROM contacts WHERE id = $1', [id]);
    return reply.status(204).send();
  });

  // GET /api/contacts/:id/overrides — list active auth overrides for a contact.
  app.get('/api/contacts/:id/overrides', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.status(400).send({ error: 'Invalid contact ID.' });

    try {
      const contact = await contactService.getContact(id);
      if (!contact) return reply.status(404).send({ error: 'Contact not found.' });
      const overrides = await contactService.getAuthOverrides(id);
      return reply.send({ overrides });
    } catch (err) {
      logger.error({ err, contactId: id }, 'GET /api/contacts/:id/overrides failed');
      return reply.status(500).send({ error: 'Failed to load auth overrides.' });
    }
  });

  // GET /api/contacts/:id/identities — list a contact's linked channel identities.
  // Read-only display surface for the contacts View drawer (#1069): the drawer shows
  // the actual channel identities (email/phone/Signal/…) Curia has on file, not just
  // the denormalized primaryEmail/primaryPhone columns.
  app.get('/api/contacts/:id/identities', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.status(400).send({ error: 'Invalid contact ID.' });

    try {
      const contact = await contactService.getContact(id);
      if (!contact) return reply.status(404).send({ error: 'Contact not found.' });
      const identities = await contactService.getIdentitiesForContact(id);
      return reply.send({ identities: identities.map(serializeIdentity) });
    } catch (err) {
      logger.error({ err, contactId: id }, 'GET /api/contacts/:id/identities failed');
      return reply.status(500).send({ error: 'Failed to load identities.' });
    }
  });

  // Channels the console may bind — single allowlist shared with contact-link-identity (#1514).
  const IDENTITY_STATUSES = new Set<IdentityStatus>(['active', 'defunct', 'bounced']);

  // POST /api/contacts/:id/identities — link a channel identity (principal-stated → verified).
  // Binding a Slack/Signal/SMS identity to the principal is the durable fix for the
  // outbound-filter principal-detection gap (#1514). Principal cache refresh is handled
  // by ContactService.onIdentitiesChanged (no route-level duplicate).
  app.post('/api/contacts/:id/identities', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.status(400).send({ error: 'Invalid contact ID.' });

    const body = (request.body ?? {}) as {
      channel?: unknown;
      channelIdentifier?: unknown;
      label?: unknown;
    };
    const channel = typeof body.channel === 'string' ? body.channel.trim() : '';
    const channelIdentifier = typeof body.channelIdentifier === 'string' ? body.channelIdentifier.trim() : '';
    const label = typeof body.label === 'string' && body.label.trim().length > 0
      ? body.label.trim()
      : undefined;

    if (!LINKABLE_CHANNEL_IDENTITY_SET.has(channel)) {
      return reply.status(400).send({
        error: `Invalid channel. Allowed: ${[...LINKABLE_CHANNEL_IDENTITY_SET].join(', ')}.`,
      });
    }
    if (!channelIdentifier) {
      return reply.status(400).send({ error: 'channelIdentifier is required.' });
    }
    if (channelIdentifier.length > 500) {
      return reply.status(400).send({ error: 'channelIdentifier must be 500 characters or fewer.' });
    }
    if (label && label.length > 200) {
      return reply.status(400).send({ error: 'label must be 200 characters or fewer.' });
    }

    try {
      const contact = await contactService.getContact(id);
      if (!contact) return reply.status(404).send({ error: 'Contact not found.' });

      const identity = await contactService.linkIdentity({
        contactId: id,
        channel,
        channelIdentifier,
        label,
        source: 'ceo_stated',
        verified: true,
      });
      return reply.status(201).send({ identity: serializeIdentity(identity) });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        return reply.status(409).send({
          error: 'That channel identity is already linked to a contact. Merge the lookalike or unlink it first.',
        });
      }
      logger.error({ err, contactId: id }, 'POST /api/contacts/:id/identities failed');
      return reply.status(500).send({ error: 'Failed to link identity.' });
    }
  });

  // PATCH /api/contacts/:id/identities/:identityId — update status and/or verify.
  app.patch('/api/contacts/:id/identities/:identityId', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id, identityId } = request.params as { id: string; identityId: string };
    if (!isUuid(id) || !isUuid(identityId)) {
      return reply.status(400).send({ error: 'Invalid contact or identity ID.' });
    }

    const body = (request.body ?? {}) as { status?: unknown; verified?: unknown };
    const hasStatus = 'status' in body;
    const hasVerified = 'verified' in body;
    if (!hasStatus && !hasVerified) {
      return reply.status(400).send({ error: 'Provide status and/or verified.' });
    }

    let nextStatus: IdentityStatus | undefined;
    if (hasStatus) {
      if (typeof body.status !== 'string' || !IDENTITY_STATUSES.has(body.status as IdentityStatus)) {
        return reply.status(400).send({ error: "status must be 'active', 'defunct', or 'bounced'." });
      }
      nextStatus = body.status as IdentityStatus;
    }
    if (hasVerified && body.verified !== true) {
      // Console verify is one-way: un-verifying would silently drop principal detection.
      return reply.status(400).send({ error: 'verified may only be set to true (use status to retire an identity).' });
    }

    try {
      const contact = await contactService.getContact(id);
      if (!contact) return reply.status(404).send({ error: 'Contact not found.' });

      const existing = await contactService.getIdentity(identityId);
      if (!existing || existing.contactId !== id) {
        return reply.status(404).send({ error: 'Identity not found on this contact.' });
      }

      let updated = existing;
      if (nextStatus !== undefined) {
        updated = await contactService.setIdentityStatus(identityId, nextStatus);
      }
      if (hasVerified && body.verified === true && !updated.verified) {
        updated = await contactService.verifyIdentity(identityId);
      }
      return reply.send({ identity: serializeIdentity(updated) });
    } catch (err) {
      if (err instanceof IdentityNotFoundError) {
        return reply.status(404).send({ error: 'Identity not found.' });
      }
      logger.error({ err, contactId: id, identityId }, 'PATCH /api/contacts/:id/identities/:identityId failed');
      return reply.status(500).send({ error: 'Failed to update identity.' });
    }
  });

  // DELETE /api/contacts/:id/identities/:identityId — unlink a channel identity.
  app.delete('/api/contacts/:id/identities/:identityId', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id, identityId } = request.params as { id: string; identityId: string };
    if (!isUuid(id) || !isUuid(identityId)) {
      return reply.status(400).send({ error: 'Invalid contact or identity ID.' });
    }

    try {
      const contact = await contactService.getContact(id);
      if (!contact) return reply.status(404).send({ error: 'Contact not found.' });

      const existing = await contactService.getIdentity(identityId);
      if (!existing || existing.contactId !== id) {
        return reply.status(404).send({ error: 'Identity not found on this contact.' });
      }

      const removed = await contactService.unlinkIdentity(identityId);
      if (!removed) return reply.status(404).send({ error: 'Identity not found.' });
      return reply.status(204).send();
    } catch (err) {
      logger.error({ err, contactId: id, identityId }, 'DELETE /api/contacts/:id/identities/:identityId failed');
      return reply.status(500).send({ error: 'Failed to unlink identity.' });
    }
  });

  // POST /api/contacts/merge — merge secondary into primary (re-points identities).
  // dryRun defaults to true so a preview is always available before commit.
  // Principal cache refresh (when primary is the principal) is via onIdentitiesChanged.
  app.post('/api/contacts/merge', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const body = (request.body ?? {}) as {
      primaryContactId?: unknown;
      secondaryContactId?: unknown;
      dryRun?: unknown;
    };
    const primaryContactId = typeof body.primaryContactId === 'string' ? body.primaryContactId : '';
    const secondaryContactId = typeof body.secondaryContactId === 'string' ? body.secondaryContactId : '';
    if (!isUuid(primaryContactId) || !isUuid(secondaryContactId)) {
      return reply.status(400).send({ error: 'primaryContactId and secondaryContactId must be valid UUIDs.' });
    }
    if (primaryContactId === secondaryContactId) {
      return reply.status(400).send({ error: 'primaryContactId and secondaryContactId must differ.' });
    }
    const dryRun = body.dryRun !== false;

    try {
      const result = await contactService.mergeContacts(primaryContactId, secondaryContactId, dryRun);
      return reply.send({
        primaryContactId: result.primaryContactId,
        secondaryContactId: result.secondaryContactId,
        dryRun: result.dryRun,
        goldenRecord: {
          displayName: result.goldenRecord.displayName,
          role: result.goldenRecord.role,
          notes: result.goldenRecord.notes,
          tier: result.goldenRecord.tier,
          identityCount: result.goldenRecord.identities.length,
          authOverrideCount: result.goldenRecord.authOverrides.length,
        },
        ...('mergedAt' in result && result.mergedAt
          ? { mergedAt: result.mergedAt.toISOString() }
          : {}),
      });
    } catch (err) {
      if (err instanceof ContactNotFoundError) {
        return reply.status(404).send({ error: err.message });
      }
      if (err instanceof StructuralContactMergeError) {
        return reply.status(400).send({ error: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('must be different')) {
        return reply.status(400).send({ error: message });
      }
      logger.error({ err, primaryContactId, secondaryContactId }, 'POST /api/contacts/merge failed');
      return reply.status(500).send({ error: 'Failed to merge contacts.' });
    }
  });

  // DELETE /api/contacts/:id/overrides/:permission — revoke a specific override.
  app.delete('/api/contacts/:id/overrides/:permission', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id, permission } = request.params as { id: string; permission: string };
    if (!isUuid(id)) return reply.status(400).send({ error: 'Invalid contact ID.' });
    if (!/^[a-z][a-z0-9_]*$/.test(permission)) {
      return reply.status(400).send({ error: 'Invalid permission name.' });
    }

    try {
      const contact = await contactService.getContact(id);
      if (!contact) return reply.status(404).send({ error: 'Contact not found.' });
      const revoked = await contactService.revokePermission(id, permission);
      if (!revoked) return reply.status(404).send({ error: 'No active override found for this permission.' });
      return reply.status(204).send();
    } catch (err) {
      logger.error({ err, contactId: id, permission }, 'DELETE /api/contacts/:id/overrides/:permission failed');
      return reply.status(500).send({ error: 'Failed to revoke override.' });
    }
  });

  // GET /api/grant-recommendations — list pending (or all) grant recommendations.
  app.get('/api/grant-recommendations', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const query = request.query as { status?: string; limit?: string };
    const statusFilter = query.status === 'pending' || query.status === 'approved' || query.status === 'declined'
      ? query.status
      : 'pending';
    const limit = Math.max(1, Math.min(Number.parseInt(query.limit ?? '50', 10) || 50, 200));

    try {
      const recommendations = await contactService.listGrantRecommendations({ status: statusFilter, limit });
      return reply.send({ recommendations });
    } catch (err) {
      logger.error({ err }, 'GET /api/grant-recommendations failed');
      return reply.status(500).send({ error: 'Failed to load grant recommendations.' });
    }
  });
}
