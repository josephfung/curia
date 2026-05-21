// handler.ts — contact-list skill implementation.
//
// Lists contacts, optionally filtered by role or status, with optional result limit.
// Returns an array of contact summaries.
//
// This skill uses contactService, which is a universal service.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ContactStatus } from '../../src/contacts/types.js';

const VALID_STATUSES: readonly ContactStatus[] = ['confirmed', 'provisional', 'blocked'];

export class ContactListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { role, status, limit } = ctx.input as {
      role?: string;
      status?: string;
      limit?: number;
    };

    // Input validation
    if (role && typeof role === 'string' && role.length > 200) {
      return { success: false, error: 'Role must be 200 characters or fewer' };
    }

    if (status != null && !VALID_STATUSES.includes(status)) {
      return { success: false, error: `Invalid status: "${status}". Must be one of: ${VALID_STATUSES.join(', ')}` };
    }

    if (limit != null) {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
        return { success: false, error: 'Limit must be a positive integer' };
      }
    }

    // Role uses a separate query path that doesn't support status/limit — reject the combination
    // rather than silently dropping filters.
    if (role && typeof role === 'string' && (status != null || limit != null)) {
      return { success: false, error: 'Cannot combine role filter with status or limit. Use role alone, or status/limit without role.' };
    }

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-list: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ role: role ?? '(all)', status: status ?? '(all)', limit: limit ?? '(none)' }, 'Listing contacts');

    try {
      // Role filter uses the dedicated findContactByRole path (no change from existing behavior)
      const contacts = role && typeof role === 'string'
        ? await ctx.contactService.findContactByRole(role)
        : await ctx.contactService.listContacts({
            status: status as ContactStatus | undefined,
            limit,
          });

      return {
        success: true,
        data: {
          contacts: contacts.map((c) => ({
            contact_id: c.id,
            display_name: c.displayName,
            role: c.role,
            status: c.status,
            kg_node_id: c.kgNodeId,
          })),
          count: contacts.length,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, role, status, limit }, 'Failed to list contacts');
      return { success: false, error: `Failed to list contacts: ${message}` };
    }
  }
}
