import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContactGrantPermissionHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { contact_id, permission, granted } = ctx.input as {
      contact_id?: string;
      permission?: string;
      granted?: boolean;
    };

    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }
    if (!permission || typeof permission !== 'string') {
      return { success: false, error: 'Missing required input: permission (string)' };
    }
    if (typeof granted !== 'boolean') {
      return { success: false, error: 'Missing required input: granted (boolean)' };
    }
    // Validate permission name format. Config-aware validation (checking against known
    // permission names) is deferred until the auth config is wired into ContactService.
    // @TODO: validate permission against authConfig.permissions when that's available.
    if (permission.length > 100) {
      return { success: false, error: 'Permission name must be 100 characters or fewer' };
    }
    if (!/^[a-z][a-z0-9_]*$/.test(permission)) {
      return { success: false, error: 'Permission name must be lowercase alphanumeric with underscores (e.g., view_financial_reports)' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'contact-grant-permission: contactService not available — this is a universal service, check ExecutionLayer configuration.' };
    }

    // Defensive guard — the execution layer guarantees caller is defined for
    // elevated skills, but guard explicitly so a broken invariant produces a
    // clear error instead of a cryptic TypeError.
    if (!ctx.caller) {
      return { success: false, error: 'Caller context is required for this skill but was not provided' };
    }

    try {
      await ctx.contactService.grantPermission(contact_id, permission, granted, ctx.caller.contactId);
      const action = granted ? 'granted' : 'denied';
      ctx.log.info({ contactId: contact_id, permission, granted }, `Permission ${action}`);
      return { success: true, data: { contact_id, permission, granted } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to set permission: ${message}` };
    }
  }
}
