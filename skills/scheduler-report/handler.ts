// handler.ts — scheduler-report skill implementation.
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class SchedulerReportHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.schedulerService) {
      return {
        success: false,
        error: 'scheduler-report requires schedulerService in context. Is infrastructure: true set in the manifest?',
      };
    }

    const { job_id, summary, context } = ctx.input as {
      job_id?: string;
      summary?: string;
      context?: Record<string, unknown>;
    };

    if (!job_id || typeof job_id !== 'string') {
      return { success: false, error: 'Missing required input: job_id (string)' };
    }
    if (!summary || typeof summary !== 'string') {
      return { success: false, error: 'Missing required input: summary (string)' };
    }

    try {
      await ctx.schedulerService.reportJobRun(job_id, summary, context);
      ctx.log.info({ jobId: job_id }, 'scheduler-report written');
      return { success: true, data: { success: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'scheduler-report failed');
      return { success: false, error: message };
    }
  }
}
