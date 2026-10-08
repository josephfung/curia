// handler.ts — scheduler-create skill implementation.
//
// Infrastructure skill that creates scheduled jobs via the SchedulerService.
// Supports both cron expressions (recurring) and ISO 8601 timestamps (one-shot).
// When intent_anchor is provided, a persistent agent_task is linked to the job.
//
// Duplicate check (#1960): a request to change an existing routine that lands here
// instead of scheduler-update makes the task fire twice. An exact copy of an active
// job (same agent, task and schedule, where a cron schedule includes its timezone)
// is refused. An active job with the same task on
// a different schedule may be a legitimate additional run, so the job is created and
// the others come back in similar_active_jobs for the agent to check.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { TaskOriginator } from '../../../../src/contacts/types.js';
import type { JobRow, SchedulerService } from '../../../../src/scheduler/scheduler-service.js';
import { validateTaskErrorBudget } from '../../../../src/tasks/task-error-budget.js';

/** Statuses of a job that will still fire (or can be resumed to fire). */
const ACTIVE_STATUSES = ['pending', 'running', 'suspended', 'paused'] as const;

interface SimilarJob {
  jobId: string;
  status: string;
  cronExpr: string | null;
  runAt: string | null;
  timezone: string;
}

/** Case- and whitespace-insensitive form of a task or cron string, for comparison. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function jobTask(job: JobRow): string | null {
  const task = job.taskPayload?.task;
  return typeof task === 'string' ? task : null;
}

/** Active jobs for this agent. listJobs filters on one status, so query each. */
async function listActiveJobs(service: SchedulerService, agentId: string): Promise<JobRow[]> {
  const pages = await Promise.all(
    ACTIVE_STATUSES.map((status) => service.listJobs({ status, agentId })),
  );
  return pages.flat();
}

/**
 * Whether an existing job fires on the schedule being requested. The same cron in
 * another timezone fires at a different instant, so a cron match also needs the
 * timezone createJob will give the new job. A one-shot run_at is an instant already.
 */
function sameSchedule(
  job: JobRow,
  cronExpr: string | undefined,
  runAt: Date | undefined,
  timezone: string,
): boolean {
  if (cronExpr) {
    return job.cronExpr !== null
      && normalize(job.cronExpr) === normalize(cronExpr)
      && job.timezone === timezone;
  }
  if (runAt && job.runAt) return new Date(job.runAt).getTime() === runAt.getTime();
  return false;
}

export class SchedulerCreateHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.schedulerService) {
      return {
        success: false,
        error: 'scheduler-create requires schedulerService in context. Declare "schedulerService" in capabilities.',
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
    if (error_budget !== undefined) {
      const budgetError = validateTaskErrorBudget(error_budget);
      if (budgetError) {
        return { success: false, error: budgetError };
      }
    }

    const agentId = agent_id ?? 'coordinator';

    // Propagate the task originator from the parent task to the scheduled job so
    // isPrincipalOriginated() returns correctly when the job fires. Without this,
    // "email my mother tomorrow at 10am" would be blocked by the elevated-skill gate
    // at fire time because the scheduler task would have no originator.
    const originator = ctx.taskMetadata?.originator as TaskOriginator | undefined;
    const runAt = run_at ? new Date(run_at) : undefined;
    // Optional per-job timezone — overrides the service default for cron wall-clock interpretation.
    // run_at is already normalized to UTC by the execution layer, so timezone only affects cron jobs.
    // Normalize to undefined if blank so createJob() falls back to the service default.
    const jobTimezone = typeof timezone === 'string' && timezone.trim() !== '' ? timezone.trim() : undefined;

    // The check is advisory: if the lookup fails, log it and create the job anyway
    // rather than block every scheduler-create on a read error.
    let similar: SimilarJob[] = [];
    try {
      const wanted = normalize(task);
      const sameTask = (await listActiveJobs(ctx.schedulerService, agentId))
        .filter((job) => {
          const t = jobTask(job);
          return t !== null && normalize(t) === wanted;
        });
      const effectiveTimezone = jobTimezone ?? ctx.schedulerService.defaultTimezone;
      const exact = sameTask.find((job) => sameSchedule(job, cron_expr, runAt, effectiveTimezone));
      if (exact) {
        ctx.log.info({ agentId, existingJobId: exact.id }, 'scheduler-create refused an exact duplicate of an active job');
        return {
          success: false,
          error:
            `Active job ${exact.id} already runs this task on this schedule for ${agentId}; ` +
            'a second copy would make it fire twice. Nothing was created. To change that job, ' +
            `call scheduler-update with job_id ${exact.id}.`,
        };
      }
      similar = sameTask.map((job) => ({
        jobId: job.id,
        status: job.status,
        cronExpr: job.cronExpr,
        runAt: job.runAt,
        timezone: job.timezone,
      }));
    } catch (err) {
      ctx.log.warn({ err, agentId }, 'scheduler-create: duplicate check failed — creating the job without it');
    }

    try {
      const result = await ctx.schedulerService.createJob({
        agentId,
        cronExpr: cron_expr,
        runAt,
        taskPayload: { task },
        createdBy: agentId,
        intentAnchor: intent_anchor,
        errorBudget: error_budget,
        timezone: jobTimezone,
        originator,
      });

      ctx.log.info({ jobId: result.jobId, agentId, originatorRole: originator?.systemRole ?? 'none' }, 'Scheduled job created via skill');

      if (similar.length > 0) {
        return {
          success: true,
          data: {
            ...result,
            similar_active_jobs: similar,
            warning:
              'Other active jobs already run this same task on a different schedule. If the request ' +
              'was to change one of those routines rather than add a run, cancel this new job with ' +
              'scheduler-cancel and edit the existing one with scheduler-update.',
          },
        };
      }
      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'scheduler-create failed');
      return { success: false, error: message };
    }
  }
}
