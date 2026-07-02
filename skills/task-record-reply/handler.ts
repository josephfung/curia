// handler.ts — task-record-reply skill (#1299).
//
// Coordinator-only durable write for task-wake CEO answers. The dispatcher injects
// binding metadata but does not auto-persist — relevance is judged by the coordinator.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { recordTaskWakeReply } from '../../src/dispatch/task-wake-reply.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TaskRecordReplyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const input = ctx.input as {
      task_id?: string;
      entry_id?: string;
      reply?: string;
    };

    if (!input.task_id || typeof input.task_id !== 'string' || !UUID_RE.test(input.task_id)) {
      return { success: false, error: 'Missing or invalid required input: task_id (UUID string)' };
    }
    if (!input.entry_id || typeof input.entry_id !== 'string' || !UUID_RE.test(input.entry_id)) {
      return { success: false, error: 'Missing or invalid required input: entry_id (UUID string)' };
    }
    if (!input.reply || typeof input.reply !== 'string' || !input.reply.trim()) {
      return { success: false, error: 'Missing required input: reply (non-empty string)' };
    }

    if (!ctx.taskRepo) {
      return { success: false, error: 'task-record-reply: taskRepo not available.' };
    }
    if (!ctx.outboundContext) {
      return { success: false, error: 'task-record-reply: outboundContext not available.' };
    }

    const result = await recordTaskWakeReply({
      reply: input.reply,
      taskId: input.task_id,
      entryId: input.entry_id,
      taskRepo: ctx.taskRepo,
      outboundContext: ctx.outboundContext,
      logger: ctx.log,
    });

    if (!result.persisted) {
      return { success: false, error: result.error ?? 'failed to record task-wake reply' };
    }

    return {
      success: true,
      data: {
        task_id: result.taskId!,
        entry_id: result.entryId!,
        recorded: true,
      },
    };
  }
}
