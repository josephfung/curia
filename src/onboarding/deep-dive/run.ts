// run.ts — the deep-dive pipeline (#2362): scan → (PR 2: backfill → draft → hand-off).
//
// Each stage reads the run state, does its work, and records what it finished, so a run resumed
// after a restart (DeepDiveService.resumeAtBoot / resumeIfStalled) starts from the last completed
// stage: a stored summary is never recomputed. Every state write is made only while the stored run
// is still this one (same startedAt) and running; a superseded run stops without writing.
//
// A failure marks the run failed, tells the operator (`deep_dive_failed`) and notes the open
// onboarding task, so its Review topics can be declined. With no onboarding task open (a re-run
// after onboarding) there is no task to note: the failure is logged and kept in the run state.

import type { ConfigStore } from '../../memory/config-store.js';
import type { PrincipalMailboxes } from '../../principal-mailboxes/service.js';
import type { TaskRepo } from '../../db/task-repo.js';
import type { WorkingDocsRepo } from '../../db/working-docs-repo.js';
import type { Logger } from '../../logger.js';
import type { OperatorNotifier } from '../notify-operator.js';
import { findOpenOnboardingTask, type OnboardingStateLock } from '../state.js';
import { summarise, type HistorySummary } from './history-summary.js';
import { HEARTBEAT_MINUTES, WINDOW_DAYS } from './limits.js';
import { scanHistory, type ScanDeps, type ScanResult } from './scan.js';
import { updateRunningDeepDive, type DeepDiveState } from './state.js';

/** Where the history summary is stored: a durable working doc, owned by no task. */
export const SUMMARY_PATH = '/meetings/onboarding/deep-dive/history-summary.md';
export const SUMMARY_DOC_TYPE = 'deep-dive-summary';

const DAY_MS = 86_400_000;

export interface RunDeps {
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  /** The process's shared onboarding state lock: every run-state write takes it. */
  stateLock: OnboardingStateLock;
  mailboxes: Pick<PrincipalMailboxes, 'list' | 'ceoClient' | 'calendarClient'>;
  workingDocsRepo: Pick<WorkingDocsRepo, 'read' | 'create' | 'update'>;
  taskRepo: Pick<TaskRepo, 'listTasks' | 'updateTask'>;
  /** The principal's home IANA timezone (index.ts principalHomeTz), read when the summary is made. */
  timezone: () => string;
  logger: Logger;
  /** How the failure notice is emailed. Absent: the failure is noted on the task, nobody is emailed. */
  notifyOperator?: OperatorNotifier;
  now?: () => Date;
  /** The history scan. Overridable in tests. */
  scan?: (deps: ScanDeps, mailboxIds: string[]) => Promise<ScanResult>;
  /** Pause used by the scan. Overridable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** How often a running scan touches updatedAt. Defaults to HEARTBEAT_MINUTES. */
  heartbeatMs?: number;
}

/** Thrown inside the pipeline when the stored run is no longer this one; ends it quietly. */
class SupersededError extends Error {
  constructor() {
    super('deep-dive: the run was superseded');
    this.name = 'SupersededError';
  }
}

export async function runDeepDive(deps: RunDeps, state: DeepDiveState): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const { logger } = deps;
  const { startedAt } = state;

  /** Write a change to this run, or stop the pipeline if it was superseded. */
  const advance = async (change: (s: DeepDiveState) => DeepDiveState): Promise<DeepDiveState> => {
    const next = await updateRunningDeepDive(deps, startedAt, (s) => ({ ...change(s), updatedAt: now().toISOString() }));
    if (next === null) throw new SupersededError();
    return next;
  };

  try {
    let current = await advance((s) => s);
    current = await scanStage(deps, current, now, advance);
    // PR 2: backfill → draft → hand-off, each from `current`.
    logger.info({ startedAt, status: current.status }, 'deep-dive: pipeline reached the end of its stages');
  } catch (err) {
    if (err instanceof SupersededError) {
      logger.info({ startedAt }, 'deep-dive: run superseded or finished elsewhere; stopping');
      return;
    }
    await recordFailure(deps, startedAt, err, now);
  }
}

/** Stage 1: scan and store the summary, unless a stored summary already exists. */
async function scanStage(
  deps: RunDeps,
  state: DeepDiveState,
  now: () => Date,
  advance: (change: (s: DeepDiveState) => DeepDiveState) => Promise<DeepDiveState>,
): Promise<DeepDiveState> {
  const { logger } = deps;
  if (state.summaryPath !== null && (await deps.workingDocsRepo.read(state.summaryPath)) !== null) {
    logger.info({ summaryPath: state.summaryPath }, 'deep-dive: summary already stored; not rescanning');
    return state.status === 'drafting' ? state : advance((s) => ({ ...s, status: 'drafting' }));
  }
  if (state.status !== 'scanning') state = await advance((s) => ({ ...s, status: 'scanning', summaryPath: null }));

  const windowEnd = now();
  const scan = deps.scan ?? scanHistory;
  const result = await withHeartbeat(deps, state.startedAt, now, () =>
    scan(
      { mailboxes: deps.mailboxes, logger, now: windowEnd, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
      state.mailboxIds,
    ),
  );
  const summary = summarise({
    ...result,
    window: { from: new Date(windowEnd.getTime() - WINDOW_DAYS * DAY_MS), to: windowEnd },
    timezone: deps.timezone(),
  });
  // Re-check before writing the doc: a superseded run must not overwrite a newer run's summary.
  await advance((s) => s);
  await storeSummary(deps, summary);
  return advance((s) => ({
    ...s,
    status: 'drafting',
    summaryPath: SUMMARY_PATH,
    requests: result.coverage.requests,
    rateLimited: result.coverage.rateLimited,
  }));
}

/**
 * Run `fn` while touching updatedAt every heartbeat, so a long scan never looks stalled to the
 * watcher (STALL_MINUTES). A failed touch is logged and the scan goes on.
 */
async function withHeartbeat<T>(deps: RunDeps, startedAt: string, now: () => Date, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    updateRunningDeepDive(deps, startedAt, (s) => ({ ...s, updatedAt: now().toISOString() })).catch((err: unknown) => {
      deps.logger.warn({ err, startedAt }, 'deep-dive: could not record scan progress; the watcher may resume this run');
    });
  }, deps.heartbeatMs ?? HEARTBEAT_MINUTES * 60_000);
  timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/** Create the summary doc, or replace an earlier run's. */
async function storeSummary(deps: RunDeps, summary: HistorySummary): Promise<void> {
  const body = '```json\n' + JSON.stringify(summary, null, 2) + '\n```\n';
  const frontmatter = { title: 'History summary' };
  const existing = await deps.workingDocsRepo.read(SUMMARY_PATH);
  if (existing === null) {
    await deps.workingDocsRepo.create({ path: SUMMARY_PATH, type: SUMMARY_DOC_TYPE, frontmatter, body, taskId: null });
    return;
  }
  const written = await deps.workingDocsRepo.update(SUMMARY_PATH, {
    type: SUMMARY_DOC_TYPE,
    frontmatter,
    body,
    taskId: null,
    expectedVersion: existing.version,
  });
  if (!written.ok) throw new Error('deep-dive: the history summary changed while it was being replaced');
}

/** Mark the run failed (only if it is still this run), then notice + note the open onboarding task. */
async function recordFailure(deps: RunDeps, startedAt: string, err: unknown, now: () => Date): Promise<void> {
  const { logger } = deps;
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err, startedAt }, 'deep-dive: run failed');
  const marked = await updateRunningDeepDive(deps, startedAt, (s) => ({
    ...s,
    status: 'failed',
    error: message,
    updatedAt: now().toISOString(),
  }));
  if (marked === null) {
    logger.warn({ startedAt }, 'deep-dive: the failed run was superseded or finished; state left as is');
    return;
  }
  let task;
  try {
    task = await findOpenOnboardingTask(deps.taskRepo);
  } catch (lookupErr) {
    logger.error({ err: lookupErr, startedAt }, 'deep-dive: could not look up the onboarding task; no failure notice sent');
    return;
  }
  if (!task) {
    logger.error({ startedAt }, 'deep-dive: run failed with no onboarding task open; no notice sent');
    return;
  }
  try {
    await deps.taskRepo.updateTask(task.id, {
      progressNote: 'Deep dive failed: no drafts are coming from it; its Review topics can be declined',
    });
  } catch (noteErr) {
    logger.error({ err: noteErr, taskId: task.id }, 'deep-dive: could not note the failure on the onboarding task');
  }
  if (deps.notifyOperator) {
    // The notifier never throws: it records its own note and logs a failed send.
    await deps.notifyOperator(task.id, 'deep_dive_failed');
  }
}
