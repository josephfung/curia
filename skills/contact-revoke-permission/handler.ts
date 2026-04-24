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
    // Validate permission name format — consistent with grant-permission handler.
    // @TODO: validate permission against authConfig.permissions when that's available.
    if (permission.length > 100) {
      return { success: false, error: 'Permission name must be 100 characters or fewer' };
    }
    if (!/^[a-z][a-z0-9_]*$/.test(permission)) {
      return { success: false, error: 'Permission name must be lowercase alphanumeric with underscores (e.g., view_financial_reports)' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'Contact service not available. contactService is a universal service — check ExecutionLayer configuration.' };
    }

    try {
      const revoked = await ctx.contactService.revokePermission(contact_id, permission);
      if (!revoked) {
        return { success: false, error: `No active permission override found for '${permission}' on this contact` };
      }
      ctx.log.info({ contactId: contact_id, permission }, 'Permission override revoked');
      return { success: true, data: { contact_id, permission, revoked: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to revoke permission: ${message}` };
    }
  }
}
