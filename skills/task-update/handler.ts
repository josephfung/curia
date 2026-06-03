// handler.ts — task-update skill.
//
// Updates mutable fields on an existing task. Status transitions from terminal states
// (done, cancelled) are rejected. Setting wake_at replaces any existing pending wake-up.
// Setting status='cancelled' also cancels pending wake-up jobs.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

const VALID_STATUSES = new Set(['open', 'in_progress', 'blocked', 'waiting', 'done', 'cancelled']);
const VALID_OWNERS = new Set(['curia', 'ceo', 'external']);

// Patterns that look like UUIDs — lightweight check before sending to DB.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TaskUpdateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const input = ctx.input as {
      task_id?: string;
      status?: string;
      priority?: number;
      owner?: string;
      due_at?: string;
      wake_at?: string;
      tags?: string[];
      progress_note?: string;
      blocked_by_task_id?: string;
    };

    if (!input.task_id || typeof input.task_id !== 'string') {
      return { success: false, error: 'Missing required input: task_id (string)' };
    }
    if (!UUID_RE.test(input.task_id)) {
      return { success: false, error: 'task_id must be a valid UUID' };
    }

    if (input.status && !VALID_STATUSES.has(input.status)) {
      return {
        success: false,
        error: `Invalid status '${input.status}'. Valid values: ${[...VALID_STATUSES].join(', ')}`,
      };
    }
    if (input.owner && !VALID_OWNERS.has(input.owner)) {
      return { success: false, error: `owner must be one of: curia, ceo, external` };
    }
    if (input.priority !== undefined) {
      if (typeof input.priority !== 'number' || input.priority < 0 || input.priority > 100) {
        return { success: false, error: 'priority must be a number between 0 and 100' };
      }
    }
    if (input.tags && !Array.isArray(input.tags)) {
      return { success: false, error: 'tags must be an array of strings' };
    }
    if (input.progress_note && input.progress_note.length > 2000) {
      return { success: false, error: 'progress_note must be 2000 characters or fewer' };
    }

    // Require at least one field to update.
    const hasUpdate = input.status !== undefined || input.priority !== undefined
      || input.owner !== undefined || input.due_at !== undefined
      || input.wake_at !== undefined || input.tags !== undefined
      || input.progress_note !== undefined || input.blocked_by_task_id !== undefined;

    if (!hasUpdate) {
      return { success: false, error: 'At least one field to update must be provided' };
    }

    if (!ctx.taskRepo) {
      return {
        success: false,
        error: 'task-update: taskRepo not available — check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ taskId: input.task_id, status: input.status }, 'Updating task');

    try {
      const updated = await ctx.taskRepo.updateTask(
        input.task_id,
        {
          status: input.status,
          priority: input.priority,
          owner: input.owner,
          dueAt: input.due_at ? new Date(input.due_at) : undefined,
          wakeAt: input.wake_at ? new Date(input.wake_at) : undefined,
          tags: input.tags,
          progressNote: input.progress_note,
          blockedByTaskId: input.blocked_by_task_id,
        },
        ctx.agentId,
      );

      if (!updated) {
        return { success: false, error: `Task not found: ${input.task_id}` };
      }

      // If status was set to 'cancelled', also cancel any pending wake-ups
      // (updateTask handles this when wakeAt is provided, but a bare status='cancelled'
      // without wakeAt still needs to cancel them).
      if (input.status === 'cancelled' && !input.wake_at) {
        await ctx.taskRepo.cancelWakeUpJobs(input.task_id);
      }

      const tz = ctx.timezone;
      return {
        success: true,
        data: {
          task_id: updated.id,
          title: updated.title,
          status: updated.status,
          owner: updated.owner,
          priority: updated.priority,
          due_at: updated.dueAt
            ? toLocalIso(new Date(updated.dueAt).getTime() / 1000, tz)
            : null,
          tags: updated.tags,
          updated_at: toLocalIso(new Date(updated.updatedAt).getTime() / 1000, tz) ?? updated.updatedAt,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : 'UTC',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, taskId: input.task_id }, 'Failed to update task');
      return { success: false, error: `Failed to update task: ${message}` };
    }
  }
}
