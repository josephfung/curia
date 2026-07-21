import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { shadowDraftPath, SHADOW_DOC_TYPE } from '../_shared/shadow-draft.js';

export class CeoInboxShadowDraftHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.workingDocs) {
      return { success: false, error: 'ceo-inbox-shadow-draft requires workingDocs' };
    }

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const sourceMessageId =
      typeof input.source_message_id === 'string' ? input.source_message_id.trim() : '';
    const subject = typeof input.subject === 'string' ? input.subject : '';
    const body = typeof input.body === 'string' ? input.body : '';
    if (!sourceMessageId || !body.trim()) {
      return { success: false, error: 'source_message_id and body are required' };
    }

    const recipients = Array.isArray(input.recipients)
      ? input.recipients.filter((r): r is string => typeof r === 'string')
      : [];

    const path = shadowDraftPath(sourceMessageId);
    try {
      const existing = await ctx.workingDocs.read(path);
      if (existing) {
        return { success: true, data: { captured: true, path, skipped_reason: 'already_exists' } };
      }
      await ctx.workingDocs.create({
        path,
        type: SHADOW_DOC_TYPE,
        frontmatter: {
          source_message_id: sourceMessageId,
          thread_id: typeof input.thread_id === 'string' ? input.thread_id : '',
          subject,
          recipients,
          created_at: new Date().toISOString(),
          shadow: true,
        },
        body,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
      });
      ctx.log.info({ path, sourceMessageId }, 'ceo-inbox-shadow-draft: captured (not surfaced)');
      return { success: true, data: { captured: true, path } };
    } catch (err) {
      ctx.log.error({ err, sourceMessageId }, 'ceo-inbox-shadow-draft: capture failed — non-blocking');
      return {
        success: true,
        data: { captured: false, skipped_reason: 'write_failed' },
      };
    }
  }
}
