// handler.ts — task-complete skill.
//
// Sets a task to 'done' and cancels pending wake-up jobs atomically.
// Kept as a separate skill from task-update so the coordinator prompt can reason about
// completion cleanly and the audit log distinguishes completion from generic updates.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TaskCompleteHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const input = ctx.input as {
      task_id?: string;
      completion_note?: string;
    };

    if (!input.task_id || typeof input.task_id !== 'string') {
      return { success: false, error: 'Missing required input: task_id (string)' };
    }
    if (!UUID_RE.test(input.task_id)) {
      return { success: false, error: 'task_id must be a valid UUID' };
    }
    if (input.completion_note !== undefined) {
      if (typeof input.completion_note !== 'string') {
        return { success: false, error: 'completion_note must be a string' };
      }
      if (input.completion_note.length > 2000) {
        return { success: false, error: 'completion_note must be 2000 characters or fewer' };
      }
    }

    if (!ctx.taskRepo) {
      return {
        success: false,
        error: 'task-complete: taskRepo not available — check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ taskId: input.task_id }, 'Completing task');

    try {
      const completed = await ctx.taskRepo.completeTask(
        input.task_id,
        input.completion_note,
        ctx.agentId,
      );

      if (!completed) {
        return { success: false, error: `Task not found: ${input.task_id}` };
      }

      const tz = ctx.timezone;
      return {
        success: true,
        data: {
          task_id: completed.id,
          title: completed.title,
          status: completed.status,
          completed_at: toLocalIso(Math.floor(new Date(completed.updatedAt).getTime() / 1000), tz) ?? completed.updatedAt,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : 'UTC',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, taskId: input.task_id }, 'Failed to complete task');
      return { success: false, error: `Failed to complete task: ${message}` };
    }
  }
}
