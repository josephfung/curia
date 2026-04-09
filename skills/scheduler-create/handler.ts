// handler.ts — scheduler-create skill implementation.
//
// Infrastructure skill that creates scheduled jobs via the SchedulerService.
// Supports both cron expressions (recurring) and ISO 8601 timestamps (one-shot).
// When intent_anchor is provided, a persistent agent_task is linked to the job.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class SchedulerCreateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.schedulerService) {
      return {
        success: false,
        error: 'scheduler-create requires schedulerService in context. Is infrastructure: true set in the manifest?',
      };
    }

    const { task, cron_expr, run_at, agent_id, intent_anchor, error_budget, timezone } = ctx.input as {
      task?: string;
      cron_expr?: string;
      run_at?: string;
      agent_id?: string;
      intent_anchor?: string;
      error_budget?: Record<string, unknown>;
      timezone?: string;
    };

    // Validate required inputs
    if (!task || typeof task !== 'string') {
      return { success: false, error: 'Missing required input: task (string)' };
    }
    if (!cron_expr && !run_at) {
      return { success: false, error: 'At least one of cron_expr or run_at must be provided' };
    }
    // Reject blank intent_anchor — a blank string would be stored in the DB and then silently
    // skipped by the runtime's truthiness guard, giving the illusion of drift prevention with none.
    if (intent_anchor !== undefined && typeof intent_anchor === 'string' && intent_anchor.trim() === '') {
      return { success: false, error: 'intent_anchor must not be blank — provide a meaningful description or omit the field' };
    }

    const agentId = agent_id ?? 'coordinator';

    try {
      const result = await ctx.schedulerService.createJob({
        agentId,
        cronExpr: cron_expr,
        runAt: run_at ? new Date(run_at) : undefined,
        taskPayload: { task },
        createdBy: agentId,
        intentAnchor: intent_anchor,
        errorBudget: error_budget,
        // Optional per-job timezone — overrides the service default for cron wall-clock interpretation.
        // run_at is already normalized to UTC by the execution layer, so timezone only affects cron jobs.
        // Normalize to undefined if blank so createJob() falls back to the service default.
        timezone: typeof timezone === 'string' && timezone.trim() !== '' ? timezone.trim() : undefined,
      });

      ctx.log.info({ jobId: result.jobId, agentId }, 'Scheduled job created via skill');

      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'scheduler-create failed');
      return { success: false, error: message };
    }
  }
}
