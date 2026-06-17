import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { writeExclusion } from '../../src/contacts/dedup-exclusions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ContactDedupExcludeHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
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
      let contactAExcluded = false;
      let contactBExcluded = false;

      // Write on A's node naming B
      if (contactA.kgNodeId !== null) {
        await writeExclusion({ contactBId, kgNodeId: contactA.kgNodeId, storeFact, source });
        contactAExcluded = true;
      }

      // Write on B's node naming A — bidirectional so hasExclusion finds it regardless of
      // which contact's node is checked first
      if (contactB.kgNodeId !== null) {
        await writeExclusion({ contactBId: contactAId, kgNodeId: contactB.kgNodeId, storeFact, source });
        contactBExcluded = true;
      }

      // If neither contact has a KG node yet, the exclusion cannot be stored anywhere.
      // Return failure so the agent knows to retry rather than telling the CEO it's done.
      if (!contactAExcluded && !contactBExcluded) {
        ctx.log.warn({ contactAId, contactBId }, 'contact-dedup-exclude: neither contact has a KG node; exclusion could not be written');
        return {
          success: false,
          error: 'Neither contact has a KG node yet — the exclusion cannot be stored. Retry after the contacts have been enriched.',
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
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contactAId, contactBId }, 'contact-dedup-exclude: failed to write exclusion facts');
      return { success: false, error: `Failed to write dedup exclusion: ${message}` };
    }
  }
}
