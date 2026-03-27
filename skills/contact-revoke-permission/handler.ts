import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContactRevokePermissionHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { contact_id, permission } = ctx.input as {
      contact_id?: string;
      permission?: string;
    };

    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }
    if (!permission || typeof permission !== 'string') {
      return { success: false, error: 'Missing required input: permission (string)' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'Contact service not available. Is infrastructure: true set?' };
    }

    try {
      await ctx.contactService.revokePermission(contact_id, permission);
      ctx.log.info({ contactId: contact_id, permission }, 'Permission override revoked');
      return { success: true, data: { contact_id, permission, revoked: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to revoke permission: ${message}` };
    }
  }
}
