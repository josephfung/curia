// handler.ts — contact-rename skill implementation.
//
// Updates a contact's display name (e.g. correcting "Jodi" to "Jodi Arnott").
// Returns the updated contact details.
//
// This skill uses contactService, which is a universal service.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContactRenameHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { contact_id, display_name } = ctx.input as {
      contact_id?: string;
      display_name?: string;
    };

    // Validate required inputs
    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }
    if (!display_name || typeof display_name !== 'string') {
      return { success: false, error: 'Missing required input: display_name (string)' };
    }

    // Validate contact_id is a UUID — the DB column is UUID type and will
    // reject slug-style IDs with a cryptic 22P02 error.
    // The agent must obtain the real UUID via contact-lookup or contact-list first.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(contact_id)) {
      return {
        success: false,
        error: "contact_id must be a valid UUID. Use contact-lookup or contact-list to obtain the contact's UUID first.",
      };
    }

    // Reject blank or whitespace-only names — a whitespace display name would break
    // contact lookup and appear as an invisible entry in the CEO's contact list.
    const trimmedName = display_name.trim();
    if (trimmedName.length === 0) {
      return { success: false, error: 'display_name must not be blank or whitespace-only' };
    }

    // Input length limit — prevent oversized payloads reaching the DB
    if (trimmedName.length > 200) {
      return { success: false, error: 'Display name must be 200 characters or fewer' };
    }

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-rename: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    // Pre-check contact existence so we can return a structured not-found response
    // without relying on error-message string matching to distinguish not-found from
    // unexpected errors (per project convention: use structured checks, not error text).
    const existing = await ctx.contactService.getContact(contact_id);
    if (!existing) {
      ctx.log.warn({ contact_id }, 'Contact not found during rename — UUID may be stale or incorrect');
      return {
        success: false,
        error: `No contact exists with id ${contact_id}. Use contact-lookup to verify the UUID, or contact-create to create a new contact.`,
      };
    }

    ctx.log.info({ contact_id, display_name: trimmedName }, 'Renaming contact');

    try {
      const updated = await ctx.contactService.updateDisplayName(contact_id, trimmedName);

      // Log both the input ID and the service-returned ID so any discrepancy is visible
      ctx.log.info(
        { inputContactId: contact_id, contactId: updated.id, displayName: updated.displayName },
        'Contact display name updated',
      );

      return {
        success: true,
        data: {
          contact_id: updated.id,
          display_name: updated.displayName,
          role: updated.role,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contact_id, display_name: trimmedName }, 'Failed to rename contact');
      return { success: false, error: `Failed to rename contact: ${message}` };
    }
  }
}
