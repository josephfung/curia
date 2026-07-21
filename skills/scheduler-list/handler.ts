// handler.ts — scheduler-list skill implementation.
//
// Infrastructure skill that lists scheduled jobs via the SchedulerService.
// Supports optional filtering by status and agent_id, and an optional limit.
//
// The listing is deliberately BOUNDED and TRIMMED (#1487): it returns at most
// `limit` jobs (most recent first) and omits the heavy per-job JSONB fields
// (taskPayload, progress, lastRunContext, lastRunSummary, taskErrorBudget,
// originator). A list view exists to identify and manage jobs — full detail for a
// single job comes from getJob / scheduler-report. Without these bounds, a large
// jobs table serialized into one tool_result overflows the model context window,
// and the follow-up LLM call fails with a non-retryable 400 (VALIDATION_ERROR),
// which surfaces to the user as the generic "unable to process" message.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { JobRow } from '../../src/scheduler/scheduler-service.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

/** Default number of jobs returned when the caller doesn't specify a limit. */
const DEFAULT_LIST_LIMIT = 50;
/** Hard ceiling on the limit, even if the caller asks for more. */
const MAX_LIST_LIMIT = 200;

/** Compact, LLM-friendly projection of a job — identification + management fields
 *  only. Heavy JSONB fields are intentionally excluded (see file header).
 *
 *  Timestamp fields (runAt, nextRunAt, lastRunAt, createdAt) are converted to the
 *  user's display timezone via toLocalIso — never returned as raw UTC Z-suffix
 *  strings, which LLMs cannot reliably convert. `timezone` remains the job's own
 *  IANA zone (the wall-clock basis for its cron), which is metadata, not an instant. */
interface JobSummary {
  id: string;
  agentId: string;
  status: string;
  cronExpr: string | null;
  runAt: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunOutcome: JobRow['lastRunOutcome'];
  consecutiveFailures: number;
  lastError: string | null;
  timezone: string;
  taskTitle: string | null;
  intentAnchor: string | null;
  taskTags: string[] | null;
  agentTaskId: string | null;
  createdBy: string;
  createdAt: string | null;
}

/** Convert a DB ISO-string instant to the user's local-timezone ISO for display.
 *  Returns null for null/invalid inputs (toLocalIso guards non-finite seconds). */
function toLocalDisplay(iso: string | null, tz: string | undefined): string | null {
  if (!iso) return null;
  return toLocalIso(Math.floor(new Date(iso).getTime() / 1000), tz);
}

function toJobSummary(job: JobRow, tz: string | undefined): JobSummary {
  return {
    id: job.id,
    agentId: job.agentId,
    status: job.status,
    cronExpr: job.cronExpr,
    runAt: toLocalDisplay(job.runAt, tz),
    nextRunAt: toLocalDisplay(job.nextRunAt, tz),
    lastRunAt: toLocalDisplay(job.lastRunAt, tz),
    lastRunOutcome: job.lastRunOutcome,
    consecutiveFailures: job.consecutiveFailures,
    lastError: job.lastError,
    timezone: job.timezone,
    taskTitle: job.taskTitle,
    intentAnchor: job.intentAnchor,
    taskTags: job.taskTags,
    agentTaskId: job.agentTaskId,
    createdBy: job.createdBy,
    createdAt: toLocalDisplay(job.createdAt, tz),
  };
}

/** Coerce an untrusted limit input into [1, MAX_LIST_LIMIT], falling back to the
 *  default for missing / non-numeric / non-positive values. */
function clampLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIST_LIMIT;
  // Math.max(1, …) so a fractional value in (0, 1) — which passes the > 0 guard but
  // floors to 0 — yields a 1-row page rather than an always-empty, falsely-truncated one.
  return Math.max(1, Math.min(Math.floor(raw), MAX_LIST_LIMIT));
}

export class SchedulerListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.schedulerService) {
      return {
        success: false,
        error: 'scheduler-list requires schedulerService in context. Declare "schedulerService" in capabilities.',
      };
    }

    const { status, agent_id, limit } = ctx.input as {
      status?: string;
      agent_id?: string;
      limit?: number;
    };

    const effectiveLimit = clampLimit(limit);
    const tz = ctx.timezone;

    try {
      // Fetch one extra row so we can report *exactly* whether more jobs exist beyond
      // the cap, rather than guessing from a full-page result.
      const rows = await ctx.schedulerService.listJobs({
        status,
        agentId: agent_id,
        limit: effectiveLimit + 1,
      });

      const truncated = rows.length > effectiveLimit;
      const jobs = (truncated ? rows.slice(0, effectiveLimit) : rows).map(job => toJobSummary(job, tz));

      return {
        success: true,
        data: {
          jobs,
          count: jobs.length,
          // True when older jobs were omitted. The agent should tell the user it is
          // showing the most recent N and can narrow with a status/agent filter.
          truncated,
          limit: effectiveLimit,
          // Timezone the displayed timestamps are in, so the agent can label them.
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : 'UTC',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'scheduler-list failed');
      return { success: false, error: message };
    }
  }
}
