// handler.ts — task-create skill.
//
// Creates a new task row. Auto-fills agent_id and source_agent_id from the caller context.
// When wake_at is provided, creates a linked one-shot scheduled_jobs row atomically.
//
// Cross-agent scheduling (target_agent_id) — DECISION (issue #880):
// By default a task is owned by, and its wake fires back to, the creating agent
// (self-routing). When `target_agent_id` is supplied, the task is instead OWNED by
// the target: tasks.agent_id and tasks.source_agent_id both become the target, and
// because the linked scheduled_jobs row inherits agent_id from the task (see
// TaskRepo.createTask), the wake fires to the target. `created_by` still records the
// real creator for audit. Owning the task — not merely redirecting the first wake —
// is what makes re-wakes correct: when the target later reschedules via task-update,
// that path routes off source_agent_id, which now points at the target.
//
// Gating: OPEN model. Any agent may target any *registered* agent. The only gate is
// existence — the target must be a known agent, otherwise the wake would fire to a
// dead agent_id that no runtime consumes. A stricter per-agent allowlist
// (`schedulable_by` in agent YAML) was considered and deliberately deferred; revisit
// if a compromised-agent threat model warrants restricting who can schedule into whom.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

const VALID_OWNERS = new Set(['curia', 'ceo', 'external']);
const VALID_SOURCES = new Set(['ceo', 'agent', 'scheduler', 'coordinator']);

// Strict ISO-8601 datetime with timezone offset. Rejects loose strings like
// "June 10 2026" or "2026/06/10" that new Date() would silently accept.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

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
      target_agent_id?: string;
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

    // Resolve the OWNING agent for this task (see the cross-agent scheduling note at
    // the top of this file). Defaults to the creator; `target_agent_id` redirects
    // ownership — and therefore the wake — to another registered agent.
    const creatorAgentId = ctx.agentId ?? 'system';
    let owningAgentId = creatorAgentId;
    if (input.target_agent_id !== undefined) {
      if (typeof input.target_agent_id !== 'string' || !input.target_agent_id.trim()) {
        return { success: false, error: 'target_agent_id must be a non-empty string' };
      }
      const target = input.target_agent_id.trim();
      // Self-targeting is just self-routing — always allowed, no registry needed.
      if (target !== creatorAgentId) {
        if (!ctx.agentRegistry) {
          return {
            success: false,
            error: 'task-create: agentRegistry not available — cannot validate target_agent_id. '
              + 'Check that the skill manifest declares the agentRegistry capability.',
          };
        }
        if (!ctx.agentRegistry.has(target)) {
          return {
            success: false,
            error: `target_agent_id '${target}' is not a registered agent — `
              + 'a wake scheduled to an unknown agent would never fire.',
          };
        }
        owningAgentId = target;
        // Cross-agent authority operation — one agent scheduling work onto
        // another agent's queue. Log it explicitly so an unexpected wake on the
        // target can be traced to its creator without DB archaeology.
        ctx.log.info(
          { creatorAgentId, owningAgentId, title: input.title },
          'task-create: redirecting task ownership to target agent',
        );
      }
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

    ctx.log.info(
      { title: input.title, owner: input.owner ?? 'curia', owningAgentId, creatorAgentId },
      'Creating task',
    );

    try {
      const task = await ctx.taskRepo.createTask({
        // owningAgentId == creatorAgentId for the default (self-routing) case;
        // a valid target_agent_id redirects ownership (and the linked wake) to it.
        agentId: owningAgentId,
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
        // source_agent_id tracks the owning specialist (drives re-wake routing in
        // TaskRepo.updateTask); created_by always records the actual creator.
        sourceAgentId: owningAgentId,
        createdBy: creatorAgentId,
      });

      const tz = ctx.timezone;
      const dueAtDisplay = task.dueAt
        ? toLocalIso(Math.floor(new Date(task.dueAt).getTime() / 1000), tz)
        : null;
      const createdAtDisplay = toLocalIso(
        Math.floor(new Date(task.createdAt).getTime() / 1000),
        tz,
      );

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
