import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContactUnlinkIdentityHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { contact_id, identity_id } = ctx.input as {
      contact_id?: string;
      identity_id?: string;
    };

    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }
    if (!identity_id || typeof identity_id !== 'string') {
      return { success: false, error: 'Missing required input: identity_id (string)' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'Contact service not available. Is infrastructure: true set?' };
    }

    try {
      await ctx.contactService.unlinkIdentity(identity_id);
      ctx.log.info({ contactId: contact_id, identityId: identity_id }, 'Channel identity unlinked');
      return { success: true, data: { removed: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to unlink identity: ${message}` };
    }
  }
}
