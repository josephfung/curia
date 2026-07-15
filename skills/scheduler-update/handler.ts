// handler.ts — scheduler-update skill implementation.
//
// Infrastructure skill that mutates an existing scheduled job via the SchedulerService.
// Unifies the three post-create lifecycle operations behind one `action` discriminator:
//   - resume: release a 'suspended' (failure-threshold) or 'paused' (drift) job → 'pending'
//   - pause:  operator hold of an active job (job + linked task → 'paused')
//   - edit:   change the schedule (cron_expr / run_at) or task_payload
//
// This mirrors the web UI's PATCH /api/jobs/:id handler, which already unifies
// resume + edit; the skill closes the gap where agents could create/list/cancel a
// job but could not resume, pause, or edit one (issue #1409).

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

// The lifecycle operations this skill exposes. resume and pause are state
// transitions; edit changes schedule/payload fields.
type SchedulerAction = 'resume' | 'pause' | 'edit';
const VALID_ACTIONS: readonly SchedulerAction[] = ['resume', 'pause', 'edit'];

export class SchedulerUpdateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.schedulerService) {
      return {
        success: false,
        error: 'scheduler-update requires schedulerService in context. Declare "schedulerService" in capabilities.',
      };
    }

    const { job_id, action, cron_expr, run_at, task_payload } = ctx.input as {
      job_id?: string;
      action?: string;
      cron_expr?: string;
      run_at?: string;
      task_payload?: Record<string, unknown>;
    };

    if (!job_id || typeof job_id !== 'string') {
      return { success: false, error: 'Missing required input: job_id (string)' };
    }
    if (!action || !VALID_ACTIONS.includes(action as SchedulerAction)) {
      return { success: false, error: `Missing or invalid input: action must be one of ${VALID_ACTIONS.join(', ')}` };
    }

    try {
      switch (action as SchedulerAction) {
        case 'resume':
          // unsuspendJob accepts both 'suspended' and 'paused' — one call covers
          // failure-suspended and drift-paused jobs. No extra notification here:
          // the CEO was already notified when a drift pause fired.
          await ctx.schedulerService.unsuspendJob(job_id);
          break;
        case 'pause':
          await ctx.schedulerService.pauseJob(job_id);
          break;
        case 'edit': {
          // Normalize whitespace-only schedule strings to absent so they don't
          // pass the has-fields check while carrying no real value (mirrors the
          // PATCH /api/jobs/:id handler). typeof guards defend against non-string input.
          const cronExpr = typeof cron_expr === 'string' ? cron_expr.trim() || undefined : undefined;
          const runAt = typeof run_at === 'string' ? run_at.trim() || undefined : undefined;

          if (cronExpr === undefined && runAt === undefined && task_payload === undefined) {
            return {
              success: false,
              error: 'action=edit requires at least one of cron_expr, run_at, or task_payload',
            };
          }

          // Parse and validate run_at here so the agent gets a clear diagnostic instead
          // of a cryptic Postgres error when a malformed string reaches the DB as an
          // Invalid Date. new Date('garbage') yields NaN rather than throwing.
          const parsedRunAt = runAt ? new Date(runAt) : undefined;
          if (parsedRunAt && Number.isNaN(parsedRunAt.getTime())) {
            return { success: false, error: `Invalid run_at: "${run_at}" is not a valid ISO 8601 timestamp` };
          }

          await ctx.schedulerService.updateJob(job_id, {
            cronExpr,
            runAt: parsedRunAt,
            taskPayload: task_payload,
          });
          break;
        }
      }

      ctx.log.info({ jobId: job_id, action }, 'Scheduled job updated via skill');

      return { success: true, data: { jobId: job_id, action } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, jobId: job_id, action }, 'scheduler-update failed');
      return { success: false, error: message };
    }
  }
}
