import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ContactTier, TaskOriginator } from '../../src/contacts/types.js';
import { isPrincipalOriginated } from '../../src/contacts/principal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 'principal' is a structural tier assigned only to the CEO contact. It cannot
// be granted via chat or UI — it is set at bootstrap and protected by API guards.
const SETTABLE_TIERS: ContactTier[] = ['blocked', 'unknown', 'known', 'trusted'];

export class ContactSetTierHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!isPrincipalOriginated(ctx.taskMetadata)) {
      ctx.log.warn('contact-set-tier: rejected — task not originated by principal');
      return { success: false, error: 'This skill requires principal authorization.' };
    }

    const { contact_id, tier, reason } = ctx.input as {
      contact_id?: string;
      tier?: string;
      reason?: string;
    };

    if (!contact_id || typeof contact_id !== 'string' || !UUID_RE.test(contact_id)) {
      return { success: false, error: 'Missing or invalid required input: contact_id (UUID)' };
    }
    if (!tier || typeof tier !== 'string') {
      return { success: false, error: 'Missing required input: tier (string)' };
    }
    if (!(SETTABLE_TIERS as string[]).includes(tier)) {
      return { success: false, error: `Invalid tier '${tier}'. Must be one of: ${SETTABLE_TIERS.join(', ')}` };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'contact-set-tier: contactService not available' };
    }

    const originator = ctx.taskMetadata?.originator as TaskOriginator | undefined;
    const actorId = ctx.caller?.contactId ?? originator?.contactId;
    if (!actorId || !UUID_RE.test(actorId)) {
      return { success: false, error: 'Cannot determine valid actor identity — neither caller nor originator provides a valid UUID contactId' };
    }

    try {
      const updated = await ctx.contactService.setTier(contact_id, tier as ContactTier);
      ctx.log.info({ contactId: contact_id, tier, reason: reason ?? null, actorId }, 'contact-set-tier: tier updated');
      return {
        success: true,
        data: {
          contact_id: updated.id,
          display_name: updated.displayName,
          tier: updated.tier,
        },
      };
    } catch (err) {
      ctx.log.error({ err, contactId: contact_id, tier }, 'contact-set-tier: setTier failed');
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to set tier: ${message}` };
    }
  }
}
