import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ContactTier, TaskOriginator } from '../../src/contacts/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 'principal' is a structural tier assigned only to the CEO contact. It cannot
// be granted via chat or UI — it is set at bootstrap and protected by API guards.
const SETTABLE_TIERS: ContactTier[] = ['blocked', 'unknown', 'known', 'trusted'];

// SECURITY: setting a contact's tier alters authorization (tier drives the Gate C tier check),
// so #1126 reclassified this from `elevated` to `normal` + action_risk:'high'. The handler no
// longer re-checks origination — the execution-layer autonomy gate governs autonomous callers
// (a woken/agent task needs score >= 80, else it surfaces an ADR-018 approval request), while a
// live-principal-driven turn (incl. the delegated contacts specialist) clears it via the
// principal-bypass. This is what lets the delegated contacts specialist run it at all — the old
// `elevated` gate would reject every delegated (derived) turn under the #1126 live-principal rule.
export class ContactSetTierHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
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
