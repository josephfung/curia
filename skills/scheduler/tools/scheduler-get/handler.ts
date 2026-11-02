// handler.ts — scheduler-get skill implementation.
//
// Reads ONE scheduled job in full (#2399). scheduler-list is deliberately trimmed
// (#1487): it drops the heavy JSONB fields and shows only a 160-character
// taskPreview, so it cannot answer "show me this routine's instructions" and gives
// an edit nothing to start from. This tool returns the scheduler-list summary plus
// the full taskPayload, the linked task's fields and the last run's record.
//
// One row cannot reproduce the #1487 overflow, but the run-record fields are
// written by agents with no write-time cap (see MAX_PRIOR_CONTEXT_CHARS in
// src/scheduler/scheduler.ts). They are capped here as a backstop, and each cut
// field is named in `truncatedFields`, so oversized run context cannot push the
// task text out. The task text itself is never cut by this handler. It is returned
// once, inside taskPayload, so a long task does not count twice against the
// execution layer's aggregate cap (200,000 characters by default). A payload past
// that cap is clipped by the layer, whose truncation marker says so: never silent.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { JobRow } from '../../../../src/scheduler/scheduler-service.js';
import { formatDisplayTimezone } from '../../../../src/time/timestamp.js';
import { isUuid } from '../../../../src/util/uuid.js';
import { toJobSummary, type JobSummary } from '../scheduler-list/handler.js';

/** Cap on the serialized lastRunContext and progress fields. */
export const MAX_DETAIL_JSON_CHARS = 8_000;
/** Cap on lastRunSummary. */
export const MAX_DETAIL_SUMMARY_CHARS = 4_000;
/** Appended to a field this handler cut. */
export const DETAIL_TRUNCATED_MARKER = '…[truncated]';

type CappedField = 'lastRunSummary' | 'lastRunContext' | 'progress';

interface JobDetail extends JobSummary {
  /** The full task payload, as stored; the task text is its `task`. scheduler-update
   *  edits replace it whole. */
  taskPayload: Record<string, unknown>;
  lastRunSummary: string | null;
  /** An object, or a string ending in DETAIL_TRUNCATED_MARKER when it was cut. */
  lastRunContext: Record<string, unknown> | string | null;
  progress: Record<string, unknown> | string | null;
}

/** Cut text past `max`, keeping the result within `max` including the marker. */
function capText(text: string, max: number): string {
  return `${text.slice(0, max - DETAIL_TRUNCATED_MARKER.length)}${DETAIL_TRUNCATED_MARKER}`;
}

/**
 * A JSON field as-is when its serialized form fits, otherwise that serialized form
 * cut to the cap. The cut is recorded in `cut` so the result names it.
 */
function capJson(
  value: Record<string, unknown> | null,
  field: CappedField,
  cut: CappedField[],
): Record<string, unknown> | string | null {
  if (value === null) return null;
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_DETAIL_JSON_CHARS) return value;
  cut.push(field);
  return capText(serialized, MAX_DETAIL_JSON_CHARS);
}

function toJobDetail(job: JobRow, tz: string | undefined, cut: CappedField[]): JobDetail {
  let lastRunSummary = job.lastRunSummary;
  if (lastRunSummary !== null && lastRunSummary.length > MAX_DETAIL_SUMMARY_CHARS) {
    cut.push('lastRunSummary');
    lastRunSummary = capText(lastRunSummary, MAX_DETAIL_SUMMARY_CHARS);
  }
  return {
    ...toJobSummary(job, tz),
    taskPayload: job.taskPayload,
    lastRunSummary,
    lastRunContext: capJson(job.lastRunContext, 'lastRunContext', cut),
    progress: capJson(job.progress, 'progress', cut),
  };
}

function notFound(jobId: string): ToolResult {
  return {
    success: false,
    error: `No scheduled job with id "${jobId}". The id may be wrong: call scheduler-list for valid job ids.`,
  };
}

export class SchedulerGetHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.schedulerService) {
      return {
        success: false,
        error: 'scheduler-get requires schedulerService in context. Declare "schedulerService" in capabilities.',
      };
    }

    const { job_id } = ctx.input as { job_id?: unknown };
    if (typeof job_id !== 'string' || job_id.trim() === '') {
      return { success: false, error: 'Missing required input: job_id (string)' };
    }
    const jobId = job_id.trim();
    // A non-UUID would reach Postgres as a uuid cast error. It names no job either way.
    if (!isUuid(jobId)) return notFound(jobId);

    const tz = ctx.timezone;
    try {
      const job = await ctx.schedulerService.getJob(jobId);
      if (!job) return notFound(jobId);

      const truncatedFields: CappedField[] = [];
      const detail = toJobDetail(job, tz, truncatedFields);
      if (truncatedFields.length > 0) {
        ctx.log.warn({ jobId, truncatedFields }, 'scheduler-get: capped oversized run-record fields');
      }

      return {
        success: true,
        data: {
          job: detail,
          // Fields cut to fit; empty when the job came back whole. The task is never cut.
          truncatedFields,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : 'UTC',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, jobId }, 'scheduler-get failed');
      return { success: false, error: message };
    }
  }
}
