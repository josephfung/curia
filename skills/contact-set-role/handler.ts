// handler.ts — contact-set-role skill implementation.
//
// Sets or changes a contact's role (e.g., CFO, board member, advisor).
// Returns the updated contact details.
//
// This is an infrastructure skill — it requires contactService access.

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

    // Infrastructure skills need contactService
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-set-role skill requires infrastructure access (contactService). Is infrastructure: true set in the manifest?',
      };
    }

    ctx.log.info({ contact_id, role }, 'Setting contact role');

    try {
      const updated = await ctx.contactService.setRole(contact_id, role);

      ctx.log.info(
        { contactId: updated.id, role: updated.role },
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
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contact_id, role }, 'Failed to set contact role');
      return { success: false, error: `Failed to set contact role: ${message}` };
    }
  }
}
