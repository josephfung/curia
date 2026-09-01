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
import { ContactNotFoundError } from '../../../../src/contacts/types.js';

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
      // decided_by is provenance for the ruling — memoryWriteSource identifies the
      // agent/task/channel that recorded it. It is the only audit trail the row carries,
      // and the row is written once and never revisited, so a missing or blank source is
      // worth a warning: it means the execution layer did not populate the context.
      const writeSource = ctx.memoryWriteSource?.trim();
      if (!writeSource) {
        ctx.log.warn(
          { contactAId, contactBId },
          'contact-dedup-exclude: ctx.memoryWriteSource absent — recording exclusion with generic provenance',
        );
      }
      const decidedBy = writeSource || 'contacts-dedup';
      const { pair, created } = await ctx.contactService.addDedupExclusion(contactAId, contactBId, decidedBy);

      ctx.log.info(
        { contactAId, contactBId, created },
        created
          ? 'contact-dedup-exclude: exclusion recorded'
          : 'contact-dedup-exclude: pair was already excluded (no-op)',
      );

      return {
        success: true,
        data: {
          // Echo the normalized (lowercase) ids so tool output matches the stored row.
          contact_a_id: pair.contactAId,
          contact_b_id: pair.contactBId,
          // false means the pair was already excluded. Still a success — the CEO's
          // decision is persisted either way, and the agent should close the task.
          created,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contactAId, contactBId }, 'contact-dedup-exclude: exclusion write failed');

      // One of the contacts is gone — the agent should re-look-up, not retry blindly.
      if (err instanceof ContactNotFoundError) {
        return {
          success: false,
          error: `${message}. One of these contacts no longer exists — re-run contact-lookup before excluding.`,
        };
      }
      // A caller mistake the validation above should already have caught.
      if (err instanceof InvalidExclusionPairError) {
        return { success: false, error: `Invalid contact pair: ${message}` };
      }
      // Deployment faults, not transient ones: the exclusions table is missing (migration
      // 084 not applied — possible when the app image leads the DB) or contactService
      // predates this tool. Both look exactly like a DB blip in a generic message, and the
      // agent prompt tells the agent to retry — which would loop forever. Say so instead.
      const tableMissing = /relation "contact_dedup_exclusions" does not exist/i.test(message);
      if (tableMissing || err instanceof TypeError) {
        return {
          success: false,
          error: `Dedup exclusions are unavailable in this deployment (${message}). This will not resolve on retry — an operator must confirm migration 084 has been applied. Leave the review task open.`,
        };
      }
      return { success: false, error: `Failed to record dedup exclusion: ${message}` };
    }
  }
}
