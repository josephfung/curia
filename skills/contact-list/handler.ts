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
    // Cast through unknown per repo convention for narrowing from Record<string, unknown>
    const { role, status, limit, offset } = ctx.input as unknown as {
      role?: string;
      status?: string;
      limit?: number;
      offset?: number;
    };

    // Input validation
    if (role && typeof role === 'string' && role.length > 200) {
      return { success: false, error: 'Role must be 200 characters or fewer' };
    }

    // Guard against a common LLM mistake: passing a lifecycle status as the role parameter.
    // The role filter searches job titles (e.g. "CEO"); lifecycle filtering uses status.
    // Normalize before comparing so casing/whitespace variants ("Provisional", " blocked") are caught too.
    const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : undefined;
    if (normalizedRole && (VALID_STATUSES as readonly string[]).includes(normalizedRole)) {
      return {
        success: false,
        error: `"${role}" is a contact lifecycle status, not a job title. Use the status parameter instead: { status: "${normalizedRole}" }`,
      };
    }

    if (status != null && !(VALID_STATUSES as readonly string[]).includes(status)) {
      return { success: false, error: `Invalid status: "${status}". Must be one of: ${VALID_STATUSES.join(', ')}` };
    }

    if (limit != null) {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
        return { success: false, error: 'Limit must be a positive integer' };
      }
    }

    if (offset != null) {
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        return { success: false, error: 'Offset must be a non-negative integer' };
      }
      // Require limit when offset > 0 to prevent accidentally returning an unbounded
      // result set starting from the middle of the table.
      if (offset > 0 && limit == null) {
        return { success: false, error: 'Offset requires limit to be set. Use limit together with offset for pagination.' };
      }
    }

    // Role uses a separate query path that doesn't support status/limit/offset — reject the combination
    // rather than silently dropping filters.
    if (role && typeof role === 'string' && (status != null || limit != null || offset != null)) {
      return { success: false, error: 'Cannot combine role filter with status, limit, or offset. Use role alone, or status/limit/offset without role.' };
    }

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-list: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ role: role ?? '(all)', status: status ?? '(all)', limit: limit ?? '(none)', offset: offset ?? 0 }, 'Listing contacts');

    try {
      // Role filter uses the dedicated findContactByRole path (no change from existing behavior)
      const contacts = role && typeof role === 'string'
        ? await ctx.contactService.findContactByRole(role)
        : await ctx.contactService.listContacts({
            status: status as ContactStatus | undefined,
            limit,
            offset,
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
      ctx.log.error({ err, role, status, limit, offset }, 'Failed to list contacts');
      return { success: false, error: `Failed to list contacts: ${message}` };
    }
  }
}
