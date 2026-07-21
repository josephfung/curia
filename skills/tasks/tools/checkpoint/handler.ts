// handler.ts — checkpoint skill (#1173).
//
// Dedicated primitive for the progress.resumable block — not folded into task-update,
// which appends human-readable notes to progress.notes instead.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import {
  boundTaskFromMetadata,
  isResumableTask,
  type BoundTaskContext,
} from '../../../../src/agents/resumable-task.js';
import { readResumableBlock } from '../../../../src/db/resumable-progress.js';
import { toLocalIso, formatDisplayTimezone } from '../../../../src/time/timestamp.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function boundTaskFromToolContext(ctx: ToolContext): BoundTaskContext | null {
  return boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined);
}

export class CheckpointHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as {
      task_id?: string;
      cursor?: string | Record<string, unknown> | null;
      done?: number;
      total?: number;
      accumulator?: unknown;
      last_slice_units?: number;
      next?: string;
    };

    const bound = boundTaskFromToolContext(ctx);
    const taskId = input.task_id ?? bound?.taskId;
    if (!taskId || typeof taskId !== 'string') {
      return {
        success: false,
        error: 'Missing task_id — provide it explicitly or run on a task-bound scheduler wake',
      };
    }
    if (!UUID_RE.test(taskId)) {
      return { success: false, error: 'task_id must be a valid UUID' };
    }

    if (typeof input.done !== 'number' || !Number.isFinite(input.done) || input.done < 0) {
      return { success: false, error: 'Missing or invalid required input: done (non-negative number)' };
    }
    if (typeof input.total !== 'number' || !Number.isFinite(input.total) || input.total < 0) {
      return { success: false, error: 'Missing or invalid required input: total (non-negative number)' };
    }
    if (
      typeof input.last_slice_units !== 'number'
      || !Number.isFinite(input.last_slice_units)
      || input.last_slice_units < 0
    ) {
      return { success: false, error: 'Missing or invalid required input: last_slice_units (non-negative number)' };
    }
    if (!input.next || typeof input.next !== 'string' || !input.next.trim()) {
      return { success: false, error: 'Missing required input: next (non-empty string)' };
    }

    if (!ctx.taskRepo) {
      return {
        success: false,
        error: 'checkpoint: taskRepo not available — check ExecutionLayer configuration.',
      };
    }

    const task = await ctx.taskRepo.getTask(taskId);
    if (!task) {
      return { success: false, error: `Task not found: ${taskId}` };
    }

    const taskContext: BoundTaskContext = {
      taskId,
      errorBudget: task.errorBudget,
      tags: task.tags,
      progress: task.progress,
    };
    if (!isResumableTask(taskContext)) {
      return {
        success: false,
        error: 'Task is not resumable — mark it with error_budget.resumable, tag "resumable", or an existing checkpoint',
      };
    }

    const cursor = input.cursor === undefined ? readResumableBlock(task.progress)?.cursor ?? null : input.cursor;
    const accumulator = input.accumulator !== undefined
      ? input.accumulator
      : readResumableBlock(task.progress)?.accumulator ?? [];

    ctx.log.info({ taskId, done: input.done, total: input.total }, 'Writing resumable checkpoint');

    try {
      const result = await ctx.taskRepo.setResumableBlock(
        taskId,
        {
          cursor,
          done: input.done,
          total: input.total,
          accumulator,
          lastSliceUnits: input.last_slice_units,
          next: input.next.trim(),
        },
        ctx.agentId,
      );

      if ('ok' in result && result.ok === false) {
        if (result.code === 'inline_accumulator_overflow') {
          return {
            success: false,
            error: `Accumulator exceeds inline cap (${result.bytes} bytes, max ${result.maxBytes}). Spill to the document workspace (#1210) and store a document pointer.`,
          };
        }
        if (result.code === 'block_overflow') {
          return {
            success: false,
            error: `Resumable block exceeds cap (${result.bytes} bytes, max ${result.maxBytes})`,
          };
        }
        return { success: false, error: result.message ?? 'Failed to write checkpoint' };
      }

      const { block } = result as { task: unknown; block: { checkpointedAt?: string } };
      const tz = ctx.timezone;
      const checkpointedAt = block.checkpointedAt ?? new Date().toISOString();
      const checkpointedAtDisplay = tz
        ? toLocalIso(Math.floor(new Date(checkpointedAt).getTime() / 1000), tz)
        : null;

      return {
        success: true,
        data: {
          task_id: taskId,
          done: input.done,
          total: input.total,
          ...(checkpointedAtDisplay != null ? { checkpointed_at: checkpointedAtDisplay } : {}),
          ...(tz ? { displayTimezone: formatDisplayTimezone(tz, new Date()) } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, taskId }, 'Failed to write checkpoint');
      return { success: false, error: `Failed to write checkpoint: ${message}` };
    }
  }
}
