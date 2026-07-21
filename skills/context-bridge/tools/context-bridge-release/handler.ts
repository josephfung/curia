//
// Marks an outbound context bridge entry as released — stops expecting replies
// for that outbound message. Coordinator-only in practice (pinned on the coordinator).
//
// When `reply` is provided and the entry is a task-wake binding (bind_reply +
// task_id in metadata), persists the CEO answer on the bound task first, then
// releases — atomically (#1299).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { isTaskWakeReplyBinding, recordTaskWakeReply } from '../../../../src/dispatch/task-wake-reply.js';

export class ContextBridgeReleaseHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { entry_id: rawEntryId, reply: rawReply } = ctx.input as {
      entry_id?: string;
      reply?: string;
    };
    const entryId = typeof rawEntryId === 'string' ? rawEntryId.trim() : '';
    const reply = typeof rawReply === 'string' ? rawReply.trim() : '';

    if (!entryId) {
      return { success: false, error: 'Missing required input: entry_id (string)' };
    }

    if (!ctx.outboundContext) {
      return {
        success: false,
        error: 'context-bridge-release requires outboundContext capability.',
      };
    }

    try {
      if (reply.length > 0) {
        const entry = await ctx.outboundContext.getEntry(entryId);
        if (!entry) {
          return { success: false, error: 'outbound context entry not found or already released' };
        }
        if (isTaskWakeReplyBinding(entry.metadata)) {
          if (!ctx.taskRepo) {
            return {
              success: false,
              error: 'context-bridge-release: taskRepo required when reply is provided for a task-wake binding.',
            };
          }
          const result = await recordTaskWakeReply({
            reply,
            entryId,
            entry,
            taskRepo: ctx.taskRepo,
            outboundContext: ctx.outboundContext,
            logger: ctx.log,
          });
          if (!result.persisted) {
            return { success: false, error: result.error ?? 'failed to record task-wake reply' };
          }
          return {
            success: true,
            data: { released: entryId, task_id: result.taskId },
          };
        }
        ctx.log.debug(
          { entryId },
          'reply ignored — entry is not a task-wake binding',
        );
        // Reply on a non-task-wake entry — ignore reply and release normally.
      }

      await ctx.outboundContext.releaseEntry(entryId);
      ctx.log.info({ entryId }, 'Context bridge entry released');
      return { success: true, data: { released: entryId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, entryId }, 'Failed to release context bridge entry');
      return { success: false, error: `Failed to release context bridge entry: ${message}` };
    }
  }
}
