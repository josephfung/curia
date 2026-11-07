// handler.ts — task-update skill.
//
// Updates mutable fields on an existing task. Status transitions from terminal states
// (done, cancelled) are rejected. Setting wake_at replaces any existing pending wake-up.
// Setting status='cancelled' also cancels pending wake-up jobs.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { UpdateTaskParams } from '../../../../src/db/task-repo.js';
import { toLocalIso, formatDisplayTimezone } from '../../../../src/time/timestamp.js';
import { isUuid } from '../../../../src/util/uuid.js';
import { dedupReviewRoute, routeFromTags } from '../../../../src/contacts/dedup-routing.js';
import { pairKeyFromDedupTask } from '../../../../src/contacts/dedup-pair-key.js';
import { SPECIALIST_DECLINE_TAG } from '../../../../src/agents/specialist-decline.js';
import {
  BLOCKED_BY_TASK_ID_ERROR,
  SELF_BLOCK_ERROR,
  foreignKeyReferenceError,
  placeholderBlockerError,
  resolveOptionalId,
  taskNotFoundError,
} from '../../optional-ref.js';

const CURIA_DEDUP_ROUTE_ERROR =
  'This dedup review is yours to decide, not the principal\'s: no person they have vouched for is on '
  + 'it, and merging changes no one\'s trust tier. Merge the pair with contact-merge, or record it as '
  + 'not a duplicate with '
  + 'contact-dedup-exclude (decided_by "curia"), then complete the task.';

const VALID_STATUSES = new Set(['open', 'in_progress', 'blocked', 'waiting', 'done', 'cancelled']);
const VALID_OWNERS = new Set(['curia', 'ceo', 'external']);

// A decline's follow-up is Curia's while Curia can act on it (#2496). Handing it to the
// principal must come with the one thing they can do that Curia cannot: answer.
export const DECLINE_HANDOFF_ERROR =
  'This task follows up a specialist decline, and moves to the principal (owner ceo) only with ' +
  'a progress_note asking them one specific question. If you can still act on it (the ' +
  'alternative the specialist offered, doing the step yourself, or a specialist that can ' +
  'unblock it), do that and leave the owner as it is.';
const MAX_PROGRESS_NOTE = 2000;
// Room for " [truncated: N characters cut]" (29 chars + digits) inside the limit.
const TRUNCATION_MARKER_RESERVE = 40;

// Strict ISO-8601 datetime with timezone offset. Rejects loose strings that new Date() would accept.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether a dedup review stamped route 'curia' is the principal's by the contacts' current
 * tiers. False when the contacts cannot be read: the stored route then stands.
 */
async function routeNowPrincipal(
  ctx: ToolContext,
  task: { tags?: string[]; description?: string | null },
): Promise<boolean> {
  const key = pairKeyFromDedupTask(task);
  if (!key || !ctx.contactService) return false;
  const [idA, idB] = key.split(':');
  if (!idA || !idB) return false;
  try {
    const [a, b] = await Promise.all([ctx.contactService.getContact(idA), ctx.contactService.getContact(idB)]);
    return a && b ? dedupReviewRoute(a, b) === 'principal' : false;
  } catch (err) {
    ctx.log.warn({ err, idA, idB }, 'task-update: could not re-read dedup pair contacts — keeping the stored route');
    return false;
  }
}

export class TaskUpdateHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as {
      task_id?: string;
      status?: string;
      priority?: number;
      owner?: string;
      due_at?: string;
      wake_at?: string;
      tags?: string[];
      progress_note?: string;
      blocked_by_task_id?: string | null;
    };

    if (!input.task_id || typeof input.task_id !== 'string') {
      return { success: false, error: 'Missing required input: task_id (string)' };
    }
    if (!isUuid(input.task_id)) {
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
    // An over-long note is truncated, not refused. Refusing threw away wake_at and status
    // from the same call, and a retry that dropped wake_at ended a re-arming loop (#2084).
    let progressNote = input.progress_note;
    let noteWarning: string | undefined;
    if (progressNote && progressNote.length > MAX_PROGRESS_NOTE) {
      const originalLength = progressNote.length;
      const keep = MAX_PROGRESS_NOTE - TRUNCATION_MARKER_RESERVE;
      progressNote = progressNote.slice(0, keep) + ` [truncated: ${originalLength - keep} characters cut]`;
      noteWarning =
        `progress_note was ${originalLength} characters, over the ${MAX_PROGRESS_NOTE} limit. ` +
        `It was truncated and saved; all other fields in this call were applied. ` +
        `Keep future notes shorter rather than re-sending the cut text.`;
      ctx.log.warn({ taskId: input.task_id, originalLength }, 'task-update: progress_note truncated');
    }
    // JSON null clears the blocker. The string "null" (and none/undefined/blank) is
    // rejected, not ignored: a success that left the blocker set would tell the
    // model the task is unblocked (#2328). Omitting the key is what leaves it
    // alone — the repo writes the column whenever the key is present.
    let blockerUpdate: { present: false } | { present: true; id: string | null } = { present: false };
    if (input.blocked_by_task_id !== undefined) {
      if (input.blocked_by_task_id === null) {
        blockerUpdate = { present: true, id: null };
      } else if (typeof input.blocked_by_task_id === 'string') {
        const placeholder = placeholderBlockerError(input.blocked_by_task_id);
        if (placeholder) return { success: false, error: placeholder };
        const resolved = resolveOptionalId('blocked_by_task_id', input.blocked_by_task_id, BLOCKED_BY_TASK_ID_ERROR);
        if (!resolved.ok) return { success: false, error: resolved.error };
        if (resolved.id !== undefined) blockerUpdate = { present: true, id: resolved.id };
      } else {
        return { success: false, error: BLOCKED_BY_TASK_ID_ERROR };
      }
    }

    // Require at least one field to update.
    const hasUpdate = input.status !== undefined || input.priority !== undefined
      || input.owner !== undefined || input.due_at !== undefined
      || input.wake_at !== undefined || input.tags !== undefined
      || input.progress_note !== undefined || blockerUpdate.present;

    if (!hasUpdate) {
      return { success: false, error: 'At least one field to update must be provided' };
    }

    let dueAt: Date | undefined;
    if (input.due_at) {
      if (!ISO_DATETIME_RE.test(input.due_at)) {
        return { success: false, error: 'due_at must be a valid ISO 8601 date string' };
      }
      dueAt = new Date(input.due_at);
      if (isNaN(dueAt.getTime())) {
        return { success: false, error: 'due_at must be a valid ISO 8601 date string' };
      }
    }
    let wakeAt: Date | undefined;
    if (input.wake_at) {
      if (!ISO_DATETIME_RE.test(input.wake_at)) {
        return { success: false, error: 'wake_at must be a valid ISO 8601 date string' };
      }
      wakeAt = new Date(input.wake_at);
      if (isNaN(wakeAt.getTime())) {
        return { success: false, error: 'wake_at must be a valid ISO 8601 date string' };
      }
    }

    if (!ctx.taskRepo) {
      return {
        success: false,
        error: 'task-update: taskRepo not available — check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ taskId: input.task_id, status: input.status }, 'Updating task');

    try {
      if (blockerUpdate.present && blockerUpdate.id !== null) {
        if (blockerUpdate.id.toLowerCase() === input.task_id.toLowerCase()) {
          return { success: false, error: SELF_BLOCK_ERROR };
        }
        const blocker = await ctx.taskRepo.getTask(blockerUpdate.id);
        if (!blocker) {
          return { success: false, error: taskNotFoundError('blocked_by_task_id', blockerUpdate.id) };
        }
      }

      // A dedup review routed to Curia is not the principal's to decide (#2493): no person
      // the principal has vouched for is on it, and a merge changes no one's tier. Refused here rather than left
      // to the prompt, since prod showed the agent handing nearly every pair over. The
      // route tag itself is kept so a tags update cannot launder the hand-over.
      if (input.owner === 'ceo' || input.tags !== undefined) {
        const current = await ctx.taskRepo.getTask(input.task_id);
        if (current && routeFromTags(current.tags) === 'curia') {
          // The stored route is the one at filing time. A contact vouched for since then
          // makes the pair the principal's, so recompute it from the current tiers; with
          // no way to read them, the stored route stands.
          if (input.owner === 'ceo' && !(await routeNowPrincipal(ctx, current))) {
            return { success: false, error: CURIA_DEDUP_ROUTE_ERROR };
          }
          if (input.tags && routeFromTags(input.tags) !== 'curia') {
            return { success: false, error: 'tags must keep the dedup-route:curia tag on a dedup review task.' };
          }
          // The scan's idempotency check and merge cleanup both find review tasks by the
          // `dedup` tag, so dropping it would let a second review be filed for the pair.
          if (input.tags && !input.tags.includes('dedup')) {
            return { success: false, error: 'tags must keep the dedup tag on a dedup review task.' };
          }
        }
      }

      if (input.owner === 'ceo' && !(progressNote ?? '').includes('?')) {
        const current = await ctx.taskRepo.getTask(input.task_id);
        if (current && current.owner !== 'ceo' && current.tags.includes(SPECIALIST_DECLINE_TAG)) {
          ctx.log.info({ taskId: input.task_id }, 'task-update: refused decline handoff to the principal without a question');
          return { success: false, error: DECLINE_HANDOFF_ERROR };
        }
      }

      // A tag replacement must not drop the decline marker the handoff rule keys on.
      let tags = input.tags;
      if (tags && !tags.includes(SPECIALIST_DECLINE_TAG)) {
        const existing = await ctx.taskRepo.getTask(input.task_id);
        if (existing?.tags.includes(SPECIALIST_DECLINE_TAG)) tags = [...tags, SPECIALIST_DECLINE_TAG];
      }

      const updates: UpdateTaskParams = {
        status: input.status,
        priority: input.priority,
        owner: input.owner,
        dueAt,
        wakeAt,
        tags,
        progressNote,
      };
      if (blockerUpdate.present) updates.blockedByTaskId = blockerUpdate.id;

      const updated = await ctx.taskRepo.updateTask(
        input.task_id,
        updates,
        ctx.agentId,
      );

      if (!updated) {
        return { success: false, error: `Task not found: ${input.task_id}` };
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
            ? toLocalIso(Math.floor(new Date(updated.dueAt).getTime() / 1000), tz)
            : null,
          tags: updated.tags,
          updated_at: toLocalIso(Math.floor(new Date(updated.updatedAt).getTime() / 1000), tz) ?? updated.updatedAt,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : 'UTC',
          ...(noteWarning && { warning: noteWarning }),
        },
      };
    } catch (err) {
      const referenced = foreignKeyReferenceError(err);
      ctx.log.error({ err, taskId: input.task_id }, 'Failed to update task');
      if (referenced) return { success: false, error: referenced };
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to update task: ${message}` };
    }
  }
}
