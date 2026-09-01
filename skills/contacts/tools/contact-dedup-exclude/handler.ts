// handler.ts — contact-dedup-exclude tool
//
// Records "these two contacts are NOT the same person" so dedup sweeps stop
// proposing the pair. Backed by the contact_dedup_exclusions table (#1625,
// ADR-039), not KG facts: an exclusion is an operational decision about a *pair*,
// so it needs no KG node on either side and works for the same-display-name
// contacts that carry kg_node_id = NULL — the population this tool used to fail
// for outright (#1623).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { InvalidExclusionPairError } from '../../../../src/contacts/dedup-exclusions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ContactDedupExcludeHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as Record<string, unknown>;
    const contactAId = input['contact_a_id'];
    const contactBId = input['contact_b_id'];

    if (typeof contactAId !== 'string' || !UUID_RE.test(contactAId)) {
      return { success: false, error: 'contact_a_id must be a valid UUID' };
    }
    if (typeof contactBId !== 'string' || !UUID_RE.test(contactBId)) {
      return { success: false, error: 'contact_b_id must be a valid UUID' };
    }
    if (contactAId.toLowerCase() === contactBId.toLowerCase()) {
      return { success: false, error: 'contact_a_id and contact_b_id must be different' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'contactService not available' };
    }

    try {
      // decided_by is provenance for the ruling. memoryWriteSource identifies the
      // agent/task/channel that recorded it; the sweep-script default keeps manual
      // and script-driven excludes distinguishable from agent ones.
      const decidedBy = ctx.memoryWriteSource ?? 'contacts-dedup';
      const { created } = await ctx.contactService.addDedupExclusion(contactAId, contactBId, decidedBy);

      ctx.log.info(
        { contactAId, contactBId, created },
        created
          ? 'contact-dedup-exclude: exclusion recorded'
          : 'contact-dedup-exclude: pair was already excluded (no-op)',
      );

      return {
        success: true,
        data: {
          contact_a_id: contactAId,
          contact_b_id: contactBId,
          // false means the pair was already excluded. Still a success — the CEO's
          // decision is persisted either way, and the agent should close the task.
          created,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // InvalidExclusionPairError is a caller mistake the validation above should
      // already have caught; surface it as-is rather than as an infrastructure error.
      const prefix = err instanceof InvalidExclusionPairError
        ? 'Invalid contact pair'
        : 'Failed to record dedup exclusion';
      ctx.log.error({ err, contactAId, contactBId }, 'contact-dedup-exclude: exclusion write failed');
      return { success: false, error: `${prefix}: ${message}` };
    }
  }
}
