// handler.ts — contact-list skill implementation.
//
// Lists all contacts, optionally filtered by role.
// Returns an array of contact summaries.
//
// This skill uses contactService, which is a universal service.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContactListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { role } = ctx.input as {
      role?: string;
    };

    // Input length limit — prevent oversized payloads reaching the DB
    if (role && typeof role === 'string' && role.length > 200) {
      return { success: false, error: 'Role must be 200 characters or fewer' };
    }

    // Infrastructure skills need contactService
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-list skill requires contactService is a universal service — check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ role: role ?? '(all)' }, 'Listing contacts');

    try {
      const contacts = role && typeof role === 'string'
        ? await ctx.contactService.findContactByRole(role)
        : await ctx.contactService.listContacts();

      return {
        success: true,
        data: {
          contacts: contacts.map((c) => ({
            contact_id: c.id,
            display_name: c.displayName,
            role: c.role,
            kg_node_id: c.kgNodeId,
          })),
          count: contacts.length,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, role }, 'Failed to list contacts');
      return { success: false, error: `Failed to list contacts: ${message}` };
    }
  }
}
