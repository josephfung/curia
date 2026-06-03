// handler.ts — contact-update skill implementation.
//
// Writes canonical profile attributes (title, organization, timezone, etc.)
// directly to the contacts table via ContactService.updateContactFields().
//
// This is the primary write path for agents that discover a canonical attribute
// about a known contact (e.g. a role change surfaced during email triage, a
// company affiliation found during research). Agents should call this skill
// directly rather than routing through memory-store.
//
// Phone normalization: primaryPhone values arrive in human-readable formats
// ("416-555-1234", "(416) 555 1234"). We normalize to E.164 via normalizePhone()
// before writing, since the DB column has a CHECK constraint. If normalization
// fails we return an error — this skill has an explicit write intent and should
// not silently fall through to the KG.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CANONICAL_ATTRIBUTE_MAP, normalizePhone } from '../../src/contacts/canonical-attribute-guard.js';
import { ContactValidationError } from '../../src/contacts/contact-service.js';
import type { ContactCanonicalFields } from '../../src/contacts/types.js';

// Derive the valid field key set from CANONICAL_ATTRIBUTE_MAP values so this
// allowlist stays in sync with the KG guard without duplicating it.
const VALID_FIELD_KEYS = new Set<keyof ContactCanonicalFields>(CANONICAL_ATTRIBUTE_MAP.values());

export class ContactUpdateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { contact_id, fields } = ctx.input as {
      contact_id?: string;
      fields?: Record<string, unknown>;
    };

    // Validate contact_id
    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }

    // Validate UUID format — the DB column rejects non-UUIDs with a cryptic 22P02 error.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(contact_id)) {
      return {
        success: false,
        error: "contact_id must be a valid UUID. Use contact-lookup or entity-context to obtain the contact's UUID first.",
      };
    }

    // Validate fields object
    if (fields === undefined || fields === null) {
      return { success: false, error: 'Missing required input: fields (object with at least one canonical field)' };
    }
    if (typeof fields !== 'object' || Array.isArray(fields)) {
      return { success: false, error: 'fields must be a plain object (e.g. { "title": "VP of Engineering" })' };
    }

    const fieldEntries = Object.entries(fields);
    if (fieldEntries.length === 0) {
      return { success: false, error: 'fields must contain at least one canonical field to update' };
    }

    // Reject unknown fields — all keys must be in the CANONICAL_ATTRIBUTE_MAP value set.
    for (const [key] of fieldEntries) {
      if (!VALID_FIELD_KEYS.has(key as keyof ContactCanonicalFields)) {
        return {
          success: false,
          error: `Unknown field: "${key}". Valid fields: ${[...VALID_FIELD_KEYS].sort().join(', ')}`,
        };
      }
    }

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-update: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    // Pre-check contact existence for a structured not-found error, rather than
    // relying on error message string-matching to distinguish not-found from unexpected errors.
    const existing = await ctx.contactService.getContact(contact_id);
    if (!existing) {
      ctx.log.warn({ contact_id }, 'Contact not found during canonical field update — UUID may be stale');
      return {
        success: false,
        error: `No contact exists with id ${contact_id}. Use contact-lookup to verify the UUID.`,
      };
    }

    // Build the patch — validate types per field and normalize primaryPhone to E.164.
    const patch: ContactCanonicalFields = {};
    for (const [key, value] of fieldEntries) {
      const typedKey = key as keyof ContactCanonicalFields;

      if (typedKey === 'primaryPhone') {
        if (value === null) {
          patch.primaryPhone = null;
          continue;
        }
        if (typeof value !== 'string') {
          return { success: false, error: 'primaryPhone must be a string or null' };
        }
        const normalized = normalizePhone(value);
        if (!normalized) {
          return {
            success: false,
            error: `primaryPhone could not be normalized to E.164 format: "${value}". Provide a valid phone number (e.g. "+14165551234" or "416-555-1234").`,
          };
        }
        patch.primaryPhone = normalized;
        continue;
      }

      // All other canonical fields accept string or null
      if (value !== null && typeof value !== 'string') {
        return { success: false, error: `Field "${key}" must be a string or null` };
      }
      (patch as Record<string, string | null | undefined>)[typedKey] = value as string | null;
    }

    const updatedFields = Object.keys(patch);
    ctx.log.info({ contact_id, fields: updatedFields }, 'Updating contact canonical fields');

    try {
      const updated = await ctx.contactService.updateContactFields(contact_id, patch);

      ctx.log.info({ contact_id: updated.id, updated_fields: updatedFields }, 'Contact canonical fields updated');

      return {
        success: true,
        data: {
          contact_id: updated.id,
          updated_fields: updatedFields,
        },
      };
    } catch (err) {
      if (err instanceof ContactValidationError) {
        // primaryEmail is not registered in contact_channel_identities for this contact.
        // The address must be linked via contact-link-identity before it can be set as primary.
        return {
          success: false,
          error: `${err.message} Use contact-link-identity to register the address for this contact before setting it as primary.`,
        };
      }
      // Map contact-service's not-found error to the same structured message as the
      // pre-check above, so callers see a consistent response regardless of race timing.
      if (err instanceof Error && err.message.startsWith('Contact not found:')) {
        return {
          success: false,
          error: `No contact exists with id ${contact_id}. Use contact-lookup to verify the UUID.`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contact_id, fields: Object.keys(patch) }, 'Failed to update contact canonical fields');
      return { success: false, error: `Failed to update contact: ${message}` };
    }
  }
}
