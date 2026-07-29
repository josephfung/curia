import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { writeExclusion } from '../../../../src/contacts/dedup-exclusions.js';

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
    if (contactAId === contactBId) {
      return { success: false, error: 'contact_a_id and contact_b_id must be different' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'contactService not available' };
    }
    if (!ctx.entityMemory) {
      return { success: false, error: 'entityMemory not available' };
    }

    // Hoisted so both variables are in scope in the catch block for partial-write logging
    let contactAExcluded = false;
    let contactBExcluded = false;

    try {
      const [contactA, contactB] = await Promise.all([
        ctx.contactService.getContact(contactAId),
        ctx.contactService.getContact(contactBId),
      ]);

      if (!contactA) {
        return { success: false, error: `Contact not found: ${contactAId}` };
      }
      if (!contactB) {
        return { success: false, error: `Contact not found: ${contactBId}` };
      }

      const source = ctx.memoryWriteSource ?? 'contacts-dedup';
      const storeFact = ctx.entityMemory.storeFact.bind(ctx.entityMemory);

      // Write on A's node naming B. Each side is independent: if A's write fails (e.g.
      // KG conflict), we still attempt B — hasExclusion is bidirectional so a single
      // side is enough to prevent the pair from resurfacing.
      //
      // Note: kg_node_id = NULL is the designed outcome of same-display-name collisions
      // (createContact retries without a KG link when idx_contacts_kg_node_unique fires).
      // Do not invent a node here — that recreates the collision (#1623 review).
      if (contactA.kgNodeId !== null) {
        try {
          await writeExclusion({ contactBId, kgNodeId: contactA.kgNodeId, storeFact, source });
          contactAExcluded = true;
        } catch (writeErrA) {
          ctx.log.error(
            { writeErrA, contactAId, contactBId },
            'contact-dedup-exclude: failed to write exclusion on A — still attempting B',
          );
        }
      } else {
        ctx.log.warn({ contactAId, contactBId }, 'contact-dedup-exclude: contact A has no KG node — exclusion written on B only');
      }

      // Write on B's node naming A — bidirectional so hasExclusion finds it regardless of
      // which contact's node is checked first
      if (contactB.kgNodeId !== null) {
        try {
          await writeExclusion({ contactBId: contactAId, kgNodeId: contactB.kgNodeId, storeFact, source });
          contactBExcluded = true;
        } catch (writeErrB) {
          ctx.log.error(
            { writeErrB, contactAId, contactBId, contactAExcluded },
            'contact-dedup-exclude: failed to write exclusion on B',
          );
        }
      } else {
        ctx.log.warn({ contactAId, contactBId }, 'contact-dedup-exclude: contact B has no KG node — exclusion written on A only');
      }

      // Both sides failed (no KG nodes, or both writes errored) — nothing was stored.
      if (!contactAExcluded && !contactBExcluded) {
        const bothMissingNodes = contactA.kgNodeId === null && contactB.kgNodeId === null;
        ctx.log.warn(
          { contactAId, contactBId, contactAHasNode: contactA.kgNodeId !== null, contactBHasNode: contactB.kgNodeId !== null },
          'contact-dedup-exclude: exclusion could not be written on either contact',
        );
        return {
          success: false,
          error: bothMissingNodes
            ? 'Could not write dedup exclusion — both contacts have no KG node (common for same-name collisions). Exclusion cannot be stored until at least one contact has a linked KG node.'
            : 'Could not write dedup exclusion on either contact — no eligible KG write succeeded (missing KG node, conflict, or store error). Check logs for details.',
        };
      }

      return {
        success: true,
        data: {
          contact_a_id: contactAId,
          contact_b_id: contactBId,
          contact_a_excluded: contactAExcluded,
          contact_b_excluded: contactBExcluded,
        },
      };
    } catch (err) {
      // Outer catch: only contact lookup failures reach here (writeExclusion errors
      // are handled above with their own per-side try/catch)
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contactAId, contactBId }, 'contact-dedup-exclude: contact lookup failed');
      return { success: false, error: `Failed to look up contacts: ${message}` };
    }
  }
}
