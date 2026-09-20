// handler.ts — scheduler-report skill implementation.
import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { parseSchedulerRunJobId } from '../../../../src/scheduler/conversation-id.js';

/**
 * Resolve which job to report against. Prefer deriving from the run conversation
 * id so agents need not pass a bare UUID (attractive nuisance — #1828). An explicit
 * job_id is still accepted for non-scheduler contexts (e.g. late-delegation wake),
 * but must agree with the run context when both are present.
 */
export function resolveSchedulerReportJobId(
  inputJobId: string | undefined,
  conversationId: string | undefined,
): { ok: true; jobId: string } | { ok: false; error: string } {
  const derived = parseSchedulerRunJobId(conversationId);
  const provided =
    typeof inputJobId === 'string' && inputJobId.trim().length > 0 ? inputJobId.trim() : undefined;

  if (provided && derived && provided !== derived) {
    return {
      ok: false,
      error:
        `job_id ${provided} does not match this run's job ${derived}; ` +
        "refusing to write another job's summary",
    };
  }

  const jobId = derived ?? provided;
  if (!jobId) {
    return {
      ok: false,
      error:
        'Missing job_id: call scheduler-report from a scheduled run ' +
        '(or pass job_id explicitly outside one)',
    };
  }
  return { ok: true, jobId };
}

export class SchedulerReportHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.schedulerService) {
      return {
        success: false,
        error: 'scheduler-report requires schedulerService in context. Declare "schedulerService" in capabilities.',
      };
    }

    const { job_id, summary, context } = ctx.input as {
      job_id?: string;
      summary?: string;
      context?: Record<string, unknown>;
    };

    if (!summary || typeof summary !== 'string') {
      return { success: false, error: 'Missing required input: summary (string)' };
    }

    const resolved = resolveSchedulerReportJobId(
      typeof job_id === 'string' ? job_id : undefined,
      ctx.conversationId,
    );
    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }

    try {
      await ctx.schedulerService.reportJobRun(resolved.jobId, summary, context);
      ctx.log.info({ jobId: resolved.jobId }, 'scheduler-report written');
      return { success: true, data: { success: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'scheduler-report failed');
      return { success: false, error: message };
    }
  }
}
