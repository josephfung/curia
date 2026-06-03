// handler.ts — task-create skill.
//
// Creates a new task row. Auto-fills agent_id and source_agent_id from the caller context.
// When wake_at is provided, creates a linked one-shot scheduled_jobs row atomically.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

const VALID_OWNERS = new Set(['curia', 'ceo', 'external']);
const VALID_SOURCES = new Set(['ceo', 'agent', 'scheduler', 'coordinator']);

export class TaskCreateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const input = ctx.input as {
      title?: string;
      description?: string;
      owner?: string;
      parent_task_id?: string;
      blocked_by_task_id?: string;
      priority?: number;
      due_at?: string;
      wake_at?: string;
      tags?: string[];
      waiting_on_contact_id?: string;
      waiting_on_text?: string;
      intent_anchor?: string;
      source?: string;
    };

    if (!input.title || typeof input.title !== 'string' || !input.title.trim()) {
      return { success: false, error: 'Missing required input: title (string)' };
    }
    if (input.title.length > 500) {
      return { success: false, error: 'title must be 500 characters or fewer' };
    }
    if (input.description && input.description.length > 5000) {
      return { success: false, error: 'description must be 5000 characters or fewer' };
    }
    if (input.owner && !VALID_OWNERS.has(input.owner)) {
      return { success: false, error: `owner must be one of: curia, ceo, external` };
    }
    if (input.source && !VALID_SOURCES.has(input.source)) {
      return { success: false, error: `source must be one of: ceo, agent, scheduler, coordinator` };
    }
    if (input.priority !== undefined) {
      if (typeof input.priority !== 'number' || input.priority < 0 || input.priority > 100) {
        return { success: false, error: 'priority must be a number between 0 and 100' };
      }
    }
    if (input.tags && !Array.isArray(input.tags)) {
      return { success: false, error: 'tags must be an array of strings' };
    }

    if (!ctx.taskRepo) {
      return {
        success: false,
        error: 'task-create: taskRepo not available — check ExecutionLayer configuration.',
      };
    }

    // Derive source from the calling agent name when not supplied.
    const derivedSource = (input.source as 'ceo' | 'agent' | 'scheduler' | 'coordinator' | undefined)
      ?? (ctx.agentId === 'coordinator' ? 'coordinator' : 'agent');

    let dueAt: Date | undefined;
    if (input.due_at) {
      dueAt = new Date(input.due_at);
      if (isNaN(dueAt.getTime())) {
        return { success: false, error: 'due_at must be a valid ISO 8601 date string' };
      }
    }
    let wakeAt: Date | undefined;
    if (input.wake_at) {
      wakeAt = new Date(input.wake_at);
      if (isNaN(wakeAt.getTime())) {
        return { success: false, error: 'wake_at must be a valid ISO 8601 date string' };
      }
    }

    ctx.log.info({ title: input.title, owner: input.owner ?? 'curia' }, 'Creating task');

    try {
      const task = await ctx.taskRepo.createTask({
        agentId: ctx.agentId ?? 'system',
        title: input.title.trim(),
        description: input.description,
        owner: (input.owner as 'curia' | 'ceo' | 'external') ?? 'curia',
        parentTaskId: input.parent_task_id,
        blockedByTaskId: input.blocked_by_task_id,
        priority: input.priority,
        dueAt,
        wakeAt,
        tags: input.tags,
        waitingOnContactId: input.waiting_on_contact_id,
        waitingOnText: input.waiting_on_text,
        intentAnchor: input.intent_anchor,
        source: derivedSource,
        sourceAgentId: ctx.agentId ?? undefined,
        createdBy: ctx.agentId ?? 'system',
      });

      const tz = ctx.timezone;
      const dueAtDisplay = task.dueAt
        ? toLocalIso(new Date(task.dueAt).getTime() / 1000, tz)
        : null;
      const createdAtDisplay = toLocalIso(new Date(task.createdAt).getTime() / 1000, tz);

      return {
        success: true,
        data: {
          task_id: task.id,
          title: task.title,
          status: task.status,
          owner: task.owner,
          priority: task.priority,
          due_at: dueAtDisplay,
          tags: task.tags,
          created_at: createdAtDisplay,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : 'UTC',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, title: input.title }, 'Failed to create task');
      return { success: false, error: `Failed to create task: ${message}` };
    }
  }
}
