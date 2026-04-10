// handler.ts — contact-set-trust skill implementation.
//
// Sets or clears a contact's per-contact trust level override.
//
// trust_level = 'high' is the primary use case: it grants a contact the same
// outbound-content access as the CEO — they may receive third-party email
// addresses in responses. Typical recipients: EA, CFO, board members.
//
// Pass trust_level = null (or omit it) to clear the override and revert to
// the channel default.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { TrustLevel } from '../../src/contacts/types.js';

const VALID_LEVELS = new Set<string>(['high', 'medium', 'low']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ContactSetTrustHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { contact_id, trust_level } = ctx.input as {
      contact_id?: string;
      trust_level?: string | null;
    };

    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }
    if (!UUID_RE.test(contact_id)) {
      return {
        success: false,
        error: "contact_id must be a valid UUID. Use contact-lookup to obtain the contact's UUID first.",
      };
    }

    // trust_level must be 'high', 'medium', 'low', or null/undefined (to clear)
    if (trust_level !== undefined && trust_level !== null && !VALID_LEVELS.has(trust_level)) {
      return {
        success: false,
        error: `trust_level must be 'high', 'medium', 'low', or null to clear the override. Got: '${trust_level}'`,
      };
    }

    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-set-trust requires infrastructure access (contactService). Is infrastructure: true set in the manifest?',
      };
    }

    // Normalise: undefined input → null (clear the override)
    const level: TrustLevel | null = (trust_level as TrustLevel) ?? null;

    // Pre-check contact existence so we can return a structured not-found response
    // without relying on error-message string matching to distinguish not-found from
    // unexpected errors (per project convention: use structured checks, not error text).
    const existing = await ctx.contactService.getContact(contact_id);
    if (!existing) {
      return {
        success: false,
        error: `No contact exists with id ${contact_id}. Use contact-lookup to verify the UUID.`,
      };
    }

    ctx.log.info({ contact_id, trust_level: level }, 'Setting contact trust level');

    try {
      const updated = await ctx.contactService.setTrustLevel(contact_id, level);

      ctx.log.info(
        { contactId: updated.id, trustLevel: updated.trustLevel },
        'Contact trust level updated',
      );

      return {
        success: true,
        data: {
          contact_id: updated.id,
          display_name: updated.displayName,
          trust_level: updated.trustLevel ?? null,
        },
      };
    } catch (err) {
      ctx.log.error({ err, contact_id }, 'Failed to set contact trust level');
      return { success: false, error: 'Failed to set contact trust level. See logs for details.' };
    }
  }
}
