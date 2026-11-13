import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { checkMailboxInput, locate, readMailboxInput } from '../../../_shared/principal-mailbox-client.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';
import { shadowDraftPath, SHADOW_DOC_TYPE } from '../../../_shared/shadow-draft.js';

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

    const mailboxError = await checkMailboxInput(ctx, input, 'ceo-inbox-shadow-draft');
    if (mailboxError) return { success: false, error: mailboxError };

    // The shadow records its mailbox so sent-observe pairs it only with sends from that mailbox
    // (#2475, D8). Omitted: the mailbox holding the source message (R69), found by locate. Only
    // when locate cannot say (not found, ambiguous, unreachable) is the default used, logged. No
    // registry (unit tests) or no mailbox: no field, which reads as the migrated mailbox's.
    const named = readMailboxInput(input);
    let mailboxId = named.ok ? named.mailbox : undefined;
    if (mailboxId === undefined && ctx.principalMailboxes) {
      try {
        const found = await locate(ctx, 'message', sourceMessageId, undefined, 'ceo-inbox-shadow-draft');
        if (found.kind === 'found') {
          mailboxId = found.at.mailbox.id;
        } else {
          mailboxId = (await ctx.principalMailboxes.defaultMailbox())?.id;
          ctx.log.warn({ sourceMessageId, locate: found.kind, mailboxId }, 'ceo-inbox-shadow-draft: source message not located; shadow filed under the default mailbox');
        }
      } catch (err) {
        ctx.log.warn({ ...grantSafeErrorFields(err) }, 'ceo-inbox-shadow-draft: mailbox unresolvable — shadow stored without a mailbox');
      }
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
          ...(mailboxId ? { mailbox: mailboxId } : {}),
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
      ctx.log.error({ ...grantSafeErrorFields(err), sourceMessageId }, 'ceo-inbox-shadow-draft: capture failed — non-blocking');
      return {
        success: true,
        data: { captured: false, skipped_reason: 'write_failed' },
      };
    }
  }
}
