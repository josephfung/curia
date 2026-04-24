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
      return { success: false, error: 'Contact service not available. contactService is a universal service — check ExecutionLayer configuration.' };
    }

    try {
      // Verify the identity belongs to this contact before unlinking
      const contactData = await ctx.contactService.getContactWithIdentities(contact_id);
      if (!contactData) {
        return { success: false, error: `Contact not found: ${contact_id}` };
      }
      const ownsIdentity = contactData.identities.some(i => i.id === identity_id);
      if (!ownsIdentity) {
        return { success: false, error: `Identity ${identity_id} does not belong to contact ${contact_id}` };
      }

      const removed = await ctx.contactService.unlinkIdentity(identity_id);
      if (!removed) {
        return { success: false, error: `Identity not found: ${identity_id}` };
      }
      ctx.log.info({ contactId: contact_id, identityId: identity_id }, 'Channel identity unlinked');
      return { success: true, data: { removed: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to unlink identity: ${message}` };
    }
  }
}
