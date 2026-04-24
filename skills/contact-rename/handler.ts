// handler.ts — contact-rename skill implementation.
//
// Updates a contact's display name (e.g. correcting "Jodi" to "Jodi Arnott").
// Returns the updated contact details.
//
// This is an infrastructure skill — it requires contactService access.

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

    // Input length limit — prevent oversized payloads reaching the DB
    if (display_name.length > 200) {
      return { success: false, error: 'Display name must be 200 characters or fewer' };
    }

    // Infrastructure skills need contactService
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-rename skill requires infrastructure access (contactService). Is infrastructure: true set in the manifest?',
      };
    }

    ctx.log.info({ contact_id, display_name }, 'Renaming contact');

    try {
      const updated = await ctx.contactService.updateDisplayName(contact_id, display_name);

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
      // ContactService.updateDisplayName() throws "Contact not found: <id>" as a normal
      // control-flow case. Surface it as a distinct, actionable error so the
      // agent knows to re-verify the UUID rather than retrying the same call.
      if (err instanceof Error && err.message.startsWith('Contact not found:')) {
        return {
          success: false,
          error: `No contact exists with id ${contact_id}. Use contact-lookup to verify the UUID, or contact-create to create a new contact.`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contact_id, display_name }, 'Failed to rename contact');
      return { success: false, error: `Failed to rename contact: ${message}` };
    }
  }
}
