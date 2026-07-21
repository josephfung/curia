// handler.ts — email-list-folders skill implementation.
//
// Lists all folders/labels in an email account via OutboundGateway.
// Read-only operation — no side effects.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';

export class EmailListFoldersHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'email-list-folders requires outboundGateway (capabilities: ["outboundGateway"])',
      };
    }

    const { account } = ctx.input as { account?: string };
    const trimmedAccount = typeof account === 'string' ? account.trim() : '';
    const accountId = trimmedAccount.length > 0 ? trimmedAccount : undefined;

    ctx.log.info({ accountId }, 'Listing email folders');

    try {
      const folders = await ctx.outboundGateway.listEmailFolders(accountId);
      return {
        success: true,
        data: {
          folders: folders.map((f) => ({ id: f.id, name: f.name })),
          count: folders.length,
        },
      };
    } catch (err) {
      ctx.log.error({ err, accountId }, 'email-list-folders: failed to list folders');
      return { success: false, error: 'Failed to list folders' };
    }
  }
}
