// handler.ts — email-create-folder skill implementation.
//
// Creates a new folder/label in an email account via OutboundGateway.
// For Gmail, this creates a user-defined label.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class EmailCreateFolderHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { name: rawName, account } = ctx.input as {
      name?: string;
      account?: string;
    };

    const name = typeof rawName === 'string' ? rawName.trim() : undefined;

    if (!name) {
      return { success: false, error: 'Missing required input: name (string)' };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'email-create-folder requires outboundGateway (capabilities: ["outboundGateway"])',
      };
    }

    const trimmedAccount = typeof account === 'string' ? account.trim() : '';
    const accountId = trimmedAccount.length > 0 ? trimmedAccount : undefined;

    ctx.log.info({ name, accountId }, 'Creating email folder');

    try {
      const folder = await ctx.outboundGateway.createEmailFolder(name, accountId);

      ctx.log.info({ folderId: folder.id, name: folder.name, accountId }, 'Email folder created');
      return {
        success: true,
        data: { id: folder.id, name: folder.name },
      };
    } catch (err) {
      ctx.log.error({ err, name, accountId }, 'email-create-folder: failed to create folder');
      return { success: false, error: 'Failed to create folder' };
    }
  }
}
