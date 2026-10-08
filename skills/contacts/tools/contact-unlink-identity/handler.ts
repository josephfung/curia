// handler.ts — contact-unlink-identity skill implementation.
//
// Removes a channel identity from a contact. A structural contact's identities (the
// principal's above all) are not an agent's to remove: see structuralContactRefusal.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { structuralContactRefusal } from '../../../../src/skills/_shared/structural-contact-guard.js';

export class ContactUnlinkIdentityHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
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
      return { success: false, error: 'contact-unlink-identity: contactService not available — this is a universal service, check ExecutionLayer configuration.' };
    }

    try {
      // Verify the identity belongs to this contact before unlinking
      const contactData = await ctx.contactService.getContactWithIdentities(contact_id);
      if (!contactData) {
        return { success: false, error: `Contact not found: ${contact_id}` };
      }
      // Before the ownership check, so nothing about a structural contact's identities
      // is reported back (#2041).
      const structural = structuralContactRefusal(
        contactData.contact,
        'Nothing was changed.',
        ctx.log,
        'contact-unlink-identity',
      );
      if (structural) return { success: false, error: structural };
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
