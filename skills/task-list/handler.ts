// handler.ts — task-list skill.
//
// Lists tasks with optional filters. Returns up to `limit` (default 25) tasks sorted
// by priority DESC, due_at ASC NULLS LAST. Joins to include the next pending wake-up.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
import type { TaskListRow } from '../../src/db/task-repo.js';

const VALID_STATUSES = new Set(['open', 'in_progress', 'blocked', 'waiting', 'done', 'cancelled']);
const VALID_OWNERS = new Set(['curia', 'ceo', 'external']);
const MAX_LIMIT = 100;

export class TaskListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const input = ctx.input as {
      status?: string;
      owner?: string;
      tag?: string;
      parent_task_id?: string;
      due_before?: string;
      limit?: number;
    };

    // Parse comma-separated status filter.
    let statuses: string[] | undefined;
    if (input.status) {
      statuses = input.status.split(',').map(s => s.trim()).filter(Boolean);
      for (const s of statuses) {
        if (!VALID_STATUSES.has(s)) {
          return {
            success: false,
            error: `Invalid status '${s}'. Valid values: ${[...VALID_STATUSES].join(', ')}`,
          };
        }
      }
    }

    if (input.owner && !VALID_OWNERS.has(input.owner)) {
      return { success: false, error: `owner must be one of: curia, ceo, external` };
    }

    const limit = input.limit !== undefined
      ? Math.min(Math.max(1, Math.floor(input.limit)), MAX_LIMIT)
      : 25;

    if (!ctx.taskRepo) {
      return {
        success: false,
        error: 'task-list: taskRepo not available — check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ statuses, owner: input.owner, limit }, 'Listing tasks');

    try {
      const rows = await ctx.taskRepo.listTasks({
        statuses,
        owner: input.owner,
        tag: input.tag,
        parentTaskId: input.parent_task_id,
        dueBefore: input.due_before ? new Date(input.due_before) : undefined,
        limit,
      });

      const tz = ctx.timezone;
      const displayTimezone = tz ? formatDisplayTimezone(tz, new Date()) : 'UTC';

      const tasks = rows.map((row: TaskListRow) => {
        const lastNote = Array.isArray(row.progress.notes) && row.progress.notes.length > 0
          ? (row.progress.notes[row.progress.notes.length - 1] as { note?: string } | null)?.note ?? null
          : null;

        const ageMs = Date.now() - new Date(row.createdAt).getTime();
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
        const age = ageDays === 0 ? 'today'
          : ageDays === 1 ? '1 day'
          : `${ageDays} days`;

        return {
          task_id: row.id,
          title: row.title,
          status: row.status,
          owner: row.owner,
          priority: row.priority,
          due_at: row.dueAt ? toLocalIso(new Date(row.dueAt).getTime() / 1000, tz) : null,
          tags: row.tags,
          age,
          last_progress_note: lastNote,
          next_wake_at: row.nextWakeAt
            ? toLocalIso(new Date(row.nextWakeAt).getTime() / 1000, tz)
            : null,
          source_agent_id: row.sourceAgentId,
          blocked_by_task_id: row.blockedByTaskId,
          parent_task_id: row.parentTaskId,
        };
      });

      return {
        success: true,
        data: {
          tasks,
          count: tasks.length,
          displayTimezone,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to list tasks');
      return { success: false, error: `Failed to list tasks: ${message}` };
    }
  }
}
