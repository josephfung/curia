// handler.ts — scheduler-cancel skill implementation.
//
// Infrastructure skill that cancels a scheduled job via the SchedulerService.
// The job is soft-deleted (status set to cancelled) and preserved for audit history.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class SchedulerCancelHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.schedulerService) {
      return {
        success: false,
        error: 'scheduler-cancel requires schedulerService in context. Is infrastructure: true set in the manifest?',
      };
    }

    const { job_id } = ctx.input as { job_id?: string };

    if (!job_id || typeof job_id !== 'string') {
      return { success: false, error: 'Missing required input: job_id (string)' };
    }

    try {
      await ctx.schedulerService.cancelJob(job_id);

      ctx.log.info({ jobId: job_id }, 'Scheduled job cancelled via skill');

      return { success: true, data: { cancelled: true, jobId: job_id } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'scheduler-cancel failed');
      return { success: false, error: message };
    }
  }
}
