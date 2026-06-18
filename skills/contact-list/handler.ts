// handler.ts — contact-list skill implementation.
//
// Lists contacts, optionally filtered by role, status, or kind, with optional
// result limit. Returns an array of contact summaries.
//
// Default behavior: excludes kind='automated' and kind='agent' from results.
// Pass kind='automated' or kind='agent' explicitly to include them.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ContactStatus, ContactKind } from '../../src/contacts/types.js';

const VALID_STATUSES: readonly ContactStatus[] = ['confirmed', 'provisional', 'blocked'];
const VALID_KINDS: readonly ContactKind[] = ['person', 'organization', 'automated', 'principal', 'agent'];

// Default People-view filter: excludes automated and agent contacts.
const DEFAULT_KIND_FILTER: ContactKind[] = ['person', 'principal', 'organization'];

export class ContactListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { role, status, kind: kindInput, limit, offset } = ctx.input as unknown as {
      role?: string;
      status?: string;
      kind?: string | string[];
      limit?: number;
      offset?: number;
    };

    // ---- Input validation ----

    if (role && typeof role === 'string' && role.length > 200) {
      return { success: false, error: 'Role must be 200 characters or fewer' };
    }

    // Guard against LLM mistake: passing a lifecycle status as the role param.
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

    // Parse kind: accept a single string or comma-separated list.
    let kindFilter: ContactKind[] | undefined;
    if (kindInput != null) {
      const rawKinds = Array.isArray(kindInput)
        ? kindInput
        : String(kindInput).split(',').map((k) => k.trim());
      for (const k of rawKinds) {
        if (!(VALID_KINDS as readonly string[]).includes(k)) {
          return { success: false, error: `Invalid kind: "${k}". Must be one of: ${VALID_KINDS.join(', ')}` };
        }
      }
      kindFilter = rawKinds as ContactKind[];
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
      if (offset > 0 && limit == null) {
        return { success: false, error: 'Offset requires limit to be set. Use limit together with offset for pagination.' };
      }
    }

    if (role && typeof role === 'string' && (status != null || limit != null || offset != null)) {
      return { success: false, error: 'Cannot combine role filter with status, limit, or offset. Use role alone, or status/limit/offset without role.' };
    }

    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-list: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    // When no kind is specified, default to the People view (excludes automated and agent).
    const effectiveKindFilter = kindFilter ?? DEFAULT_KIND_FILTER;

    ctx.log.info(
      { role: role ?? '(all)', status: status ?? '(all)', kind: effectiveKindFilter, limit: limit ?? '(none)', offset: offset ?? 0 },
      'Listing contacts',
    );

    try {
      // TODO: role path bypasses kind filter — findContactByRole has no kind param; acceptable since role and kind are semantically orthogonal
      const contacts = role && typeof role === 'string'
        ? await ctx.contactService.findContactByRole(role)
        : await ctx.contactService.listContacts({
            status: status as ContactStatus | undefined,
            kind: effectiveKindFilter,
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
