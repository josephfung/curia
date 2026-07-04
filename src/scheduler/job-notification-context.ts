// job-notification-context.ts — lightweight DB-backed context for scheduler CEO emails.
//
// RecoveryNotifier and SuspensionNotifier bypass the LLM pipeline; this module supplies
// human-readable job objective, recurrence, and console deep-link fields from scheduled_jobs.

import type { Logger } from '../logger.js';
import { classifyError } from '../errors/classify.js';
import type { JobRow, SchedulerService } from './scheduler-service.js';

const MAX_OBJECTIVE_LENGTH = 200;

/** Format an ISO timestamp as a UTC wall-clock string for notification bodies. */
export function formatUtcTimestamp(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day} ${h}:${min} UTC`;
}

function truncateObjective(text: string): string {
  return text.length > MAX_OBJECTIVE_LENGTH
    ? `${text.slice(0, MAX_OBJECTIVE_LENGTH - 1)}…`
    : text;
}

/**
 * Derive a short human-readable objective for a scheduled job.
 * Prefers last_run_summary; otherwise intent_anchor / task title / task_payload fields.
 */
export function deriveJobObjective(job: JobRow): string {
  const summary = job.lastRunSummary?.trim();
  if (summary) return truncateObjective(summary);

  const anchor = job.intentAnchor?.trim();
  if (anchor) return truncateObjective(anchor);

  const title = job.taskTitle?.trim();
  if (title) return truncateObjective(title);

  return truncateObjective(deriveObjectiveFromPayload(job.taskPayload));
}

/** Parse task_payload defensively for a human-readable intent string. */
export function deriveObjectiveFromPayload(payload: Record<string, unknown>): string {
  const intent = readNonEmptyString(payload['intent']);
  if (intent) return intent;

  const task = readNonEmptyString(payload['task']);
  if (task) return task;

  const description = readNonEmptyString(payload['description']);
  if (description) return description;

  const summary = readNonEmptyString(payload['summary']);
  if (summary) return summary;

  const skill = readNonEmptyString(payload['skill']);
  if (skill) {
    const query = readNonEmptyString(payload['query']);
    return query ? `${skill}: ${query}` : skill;
  }

  const type = readNonEmptyString(payload['type']);
  if (type === 'task-wake') return 'Task wake-up';

  if (type) return type;

  return '(no objective recorded)';
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Format recurrence type for notification bodies. */
export function formatJobRecurrence(job: JobRow): string {
  if (job.cronExpr) {
    return `Recurring (cron: \`${job.cronExpr}\`)`;
  }
  if (job.runAt) {
    return `One-shot (was due: \`${formatUtcTimestamp(job.runAt)}\`)`;
  }
  return 'Unknown schedule';
}

/** Build a console deep-link URL for a scheduled job. */
export function buildJobConsoleUrl(
  appOrigin: string | undefined,
  httpPort: number,
  jobId: string,
): string {
  const origin = (appOrigin?.trim() ? appOrigin : `http://localhost:${httpPort}`).replace(/\/+$/, '');
  return `${origin}/jobs/${jobId}`;
}

export interface JobNotificationContext {
  objective: string;
  recurrence: string;
  consoleUrl: string;
}

/** Assemble notification context fields from a loaded job row. */
export function buildJobNotificationContext(
  job: JobRow,
  appOrigin: string | undefined,
  httpPort: number,
): JobNotificationContext {
  return {
    objective: deriveJobObjective(job),
    recurrence: formatJobRecurrence(job),
    consoleUrl: buildJobConsoleUrl(appOrigin, httpPort, job.id),
  };
}

/**
 * Load job context for CEO notification emails. Fail-open: a lookup error must not
 * block the underlying recovery/suspension notification from reaching the CEO.
 */
export async function loadJobNotificationContext(
  schedulerService: Pick<SchedulerService, 'getJob'>,
  appOrigin: string | undefined,
  httpPort: number,
  jobId: string,
  logger: Logger,
  source: string,
): Promise<JobNotificationContext> {
  const consoleUrl = buildJobConsoleUrl(appOrigin, httpPort, jobId);
  try {
    const job = await schedulerService.getJob(jobId);
    if (!job) {
      return { objective: '(job not found)', recurrence: '(unknown)', consoleUrl };
    }
    return buildJobNotificationContext(job, appOrigin, httpPort);
  } catch (err: unknown) {
    const agentErr = classifyError(err, source);
    logger.warn({ err: agentErr, jobId }, `${source}: failed to load job context for notification`);
    return { objective: '(unavailable)', recurrence: '(unknown)', consoleUrl };
  }
}
