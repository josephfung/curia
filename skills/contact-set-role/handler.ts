// handler.ts — contact-set-role skill implementation.
//
// Sets or changes a contact's role (e.g., CFO, board member, advisor).
// Returns the updated contact details.
//
// This skill uses contactService, which is a universal service.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContactSetRoleHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { contact_id, role } = ctx.input as {
      contact_id?: string;
      role?: string;
    };

    // Validate required inputs
    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }
    if (!role || typeof role !== 'string') {
      return { success: false, error: 'Missing required input: role (string)' };
    }

    // Validate contact_id is a UUID — the DB column is UUID type and will
    // reject slug-style IDs like "contact_joseph_fung" with a cryptic 22P02 error.
    // The agent must obtain the real UUID via contact-lookup or contact-create first.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(contact_id)) {
      return {
        success: false,
        error: 'contact_id must be a valid UUID. Use contact-lookup or contact-create to obtain the contact\'s UUID first.',
      };
    }

    // Input length limit — prevent oversized payloads reaching the DB
    if (role.length > 200) {
      return { success: false, error: 'Role must be 200 characters or fewer' };
    }

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-set-role: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ contact_id, role }, 'Setting contact role');

    try {
      const updated = await ctx.contactService.setRole(contact_id, role);

      // Log both the input ID and the service-returned ID so any discrepancy is visible
      ctx.log.info(
        { inputContactId: contact_id, contactId: updated.id, role: updated.role },
        'Contact role updated',
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
      // ContactService.setRole() throws "Contact not found: <id>" as a normal
      // control-flow case. Surface it as a distinct, actionable error so the
      // agent knows to re-verify the UUID rather than retrying the same call.
      if (err instanceof Error && err.message.startsWith('Contact not found:')) {
        return {
          success: false,
          error: `No contact exists with id ${contact_id}. Use contact-lookup to verify the UUID, or contact-create to create a new contact.`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contact_id, role }, 'Failed to set contact role');
      return { success: false, error: `Failed to set contact role: ${message}` };
    }
  }
}
