// handler.ts — scheduler-report skill implementation.
import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { parseSchedulerRunJobId } from '../../../../src/scheduler/conversation-id.js';

export type ResolveSchedulerReportJobIdResult =
  | { ok: true; jobId: string; ignoredProvidedJobId?: string }
  | { ok: false; error: string };

/**
 * Resolve which job to report against. Prefer deriving from the run conversation
 * id so agents need not pass a bare UUID (attractive nuisance — #1828).
 *
 * When a derived id is present it is authoritative: a disagreeing explicit
 * `job_id` is ignored (with a warning at the call site) rather than hard-failing
 * the report — a hallucinated/stale UUID must not cost the run its summary.
 * Outside a scheduler conversation an explicit `job_id` is still required.
 */
export function resolveSchedulerReportJobId(
  inputJobId: unknown,
  conversationId: string | undefined,
): ResolveSchedulerReportJobIdResult {
  const derived = parseSchedulerRunJobId(conversationId);

  if (inputJobId !== undefined && inputJobId !== null && typeof inputJobId !== 'string') {
    return {
      ok: false,
      error: `job_id must be a string (got ${typeof inputJobId})`,
    };
  }

  const provided =
    typeof inputJobId === 'string' && inputJobId.trim().length > 0 ? inputJobId.trim() : undefined;

  if (derived) {
    if (provided && provided !== derived) {
      return { ok: true, jobId: derived, ignoredProvidedJobId: provided };
    }
    return { ok: true, jobId: derived };
  }

  if (!provided) {
    return {
      ok: false,
      error:
        'Missing job_id: call scheduler-report from a scheduled run ' +
        '(or pass job_id explicitly outside one)',
    };
  }
  return { ok: true, jobId: provided };
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
      job_id?: unknown;
      summary?: string;
      context?: Record<string, unknown>;
    };

    if (!summary || typeof summary !== 'string') {
      return { success: false, error: 'Missing required input: summary (string)' };
    }

    const resolved = resolveSchedulerReportJobId(job_id, ctx.conversationId);
    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }
    if (resolved.ignoredProvidedJobId) {
      ctx.log.warn(
        { provided: resolved.ignoredProvidedJobId, derived: resolved.jobId },
        'scheduler-report: ignoring job_id that does not match this run; writing to derived job',
      );
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
