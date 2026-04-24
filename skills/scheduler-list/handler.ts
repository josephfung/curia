// handler.ts — scheduler-list skill implementation.
//
// Infrastructure skill that lists scheduled jobs via the SchedulerService.
// Supports optional filtering by status and agent_id.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class SchedulerListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.schedulerService) {
      return {
        success: false,
        error: 'scheduler-list requires schedulerService in context. Declare "schedulerService" in capabilities.',
      };
    }

    const { status, agent_id } = ctx.input as {
      status?: string;
      agent_id?: string;
    };

    try {
      const jobs = await ctx.schedulerService.listJobs({
        status,
        agentId: agent_id,
      });

      return { success: true, data: { jobs } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'scheduler-list failed');
      return { success: false, error: message };
    }
  }
}
