// run.ts — the deep-dive pipeline (#2362): scan → backfill → draft → hand-off (./handoff.ts).
//
// Each stage reads the run state, does its work, and records what it finished, so a run resumed
// after a restart (DeepDiveService.resumeAtBoot / resumeIfStalled) starts from the last completed
// stage: a stored summary is never recomputed (it is read back and its shape checked), contacts
// are not backfilled twice, a draft this run already wrote is not redrafted, and a review task
// already created is reused. Every state write is made only while the stored run is still this one
// (same startedAt) and running; a superseded run stops without writing. A run that hands off is
// `delivered`, which is not running, so neither the watcher nor boot fires it again.
//
// A failure marks the run failed, tells the operator (`deep_dive_failed`) and notes the open
// onboarding task, so its Review topics can be declined. With no onboarding task open (a re-run
// after onboarding) there is no task to note: the failure is logged and kept in the run state.

import type { ConfigStore } from '../../memory/config-store.js';
import type { PrincipalMailboxes } from '../../principal-mailboxes/service.js';
import type { TaskRepo } from '../../db/task-repo.js';
import type { WorkingDocsRepo } from '../../db/working-docs-repo.js';
import type { EventBus } from '../../bus/bus.js';
import type { LLMProvider } from '../../agents/llm/provider.js';
import type { ModelRouter } from '../../agents/llm/model-router.js';
import type { ModelRegistry } from '../../agents/llm/model-registry.js';
import type { ExecutiveProfileService } from '../../executive/service.js';
import type { OfficeIdentityService } from '../../identity/service.js';
import type { SchedulerService } from '../../scheduler/scheduler-service.js';
import type { Logger } from '../../logger.js';
import { EDITABLE_BY_CONSOLE, EDITABLE_BY_KEY } from '../../memory/console-only-docs.js';
import type { OperatorNotifier } from '../notify-operator.js';
import type { OnboardingService } from '../onboarding-service.js';
import { findOpenOnboardingTask, type OnboardingStateLock } from '../state.js';
import { noteAndWakeCoordinator } from '../subscribers.js';
import { isOpenTask } from '../subtasks.js';
import { backfillContacts, type BackfillDeps } from './backfill.js';
import { draftDocuments, DraftError, readDraftInputs, type DraftDeps, type DraftInputs, type DraftKind } from './draft.js';
import { handoffStage } from './handoff.js';
import { summarise, type HistorySummary } from './history-summary.js';
import { HEARTBEAT_MINUTES, WINDOW_DAYS } from './limits.js';
import { DRAFT_PATHS } from './paths.js';
import { DRAFT_KINDS } from './prompts.js';
import { scanHistory, type ScanDeps, type ScanResult } from './scan.js';
import { updateRunningDeepDive, type DeepDiveState } from './state.js';

/** Where the history summary is stored: a durable working doc, owned by no task. */
export const SUMMARY_PATH = '/meetings/onboarding/deep-dive/history-summary.md';
export const SUMMARY_DOC_TYPE = 'deep-dive-summary';

export { DRAFT_PATHS } from './paths.js';
export const DRAFT_DOC_TYPE = 'deep-dive-draft';
const DRAFT_TITLES: Readonly<Record<DraftKind, string>> = {
  'working-rules': 'Working rules (draft)',
  'time-and-priorities': 'Time and priorities (draft)',
  'writing-voice': 'Writing voice (draft)',
};

const DAY_MS = 86_400_000;

export interface RunDeps {
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  /** The process's shared onboarding state lock: every run-state write takes it. */
  stateLock: OnboardingStateLock;
  mailboxes: Pick<PrincipalMailboxes, 'list' | 'ceoClient' | 'calendarClient'>;
  workingDocsRepo: Pick<WorkingDocsRepo, 'read' | 'create' | 'update'>;
  taskRepo: Pick<TaskRepo, 'listTasks' | 'updateTask' | 'getTask' | 'createTask' | 'setActiveSkillsBlock'>;
  /** The contacts backfill writes through it. */
  contactService: BackfillDeps['contactService'];
  /** The hand-off opens the Review session's topics on the review task. */
  onboardingService: Pick<OnboardingService, 'openSession'>;
  /** The hand-off wakes the coordinator on the review task. */
  scheduler: Pick<SchedulerService, 'enqueueTaskWake' | 'runTaskWakeEarly'>;
  // Drafting's model access (see DraftDeps): passed on by name, never as a wider bag.
  providerRouter: LLMProvider;
  modelRouter: ModelRouter;
  bus: EventBus;
  estimateCost: DraftDeps['estimateCost'];
  modelRegistry: ModelRegistry;
  /** The voice profile drafting compares against. Absent when the service failed to start. */
  executiveProfile?: Pick<ExecutiveProfileService, 'get'>;
  /** Behavioral preferences drafting compares against. */
  officeIdentity: Pick<OfficeIdentityService, 'get'>;
  /** The principal's working-hours KG fact; null when none is recorded. */
  readWorkingHours: () => Promise<string | null>;
  /** The principal's home IANA timezone (index.ts principalHomeTz), read when the summary is made. */
  timezone: () => string;
  logger: Logger;
  /** How the failure notice is emailed. Absent: the failure is noted on the task, nobody is emailed. */
  notifyOperator?: OperatorNotifier;
  now?: () => Date;
  /** The history scan. Overridable in tests. */
  scan?: (deps: ScanDeps, mailboxIds: string[]) => Promise<ScanResult>;
  /** Drafting. Overridable in tests. */
  draft?: (
    deps: DraftDeps,
    inputs: DraftInputs,
    kinds: readonly DraftKind[],
  ) => Promise<{ drafts: Partial<Record<DraftKind, string>>; spendUsd: number }>;
  /** Pause used by the scan. Overridable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** How often a long stage (scan, backfill, a draft) touches updatedAt. Defaults to HEARTBEAT_MINUTES. */
  heartbeatMs?: number;
}

/** Write a change to the running run, or stop the pipeline (SupersededError) if it was superseded. */
export type Advance = (change: (s: DeepDiveState) => DeepDiveState) => Promise<DeepDiveState>;

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
  // The run is identified by startedAt, and a resume reuses it. So a live run whose heartbeat
  // writes keep failing for STALL_MINUTES can be resumed while it still runs, and the two attempts
  // overlap (both pass this guard). A per-attempt token would close that; deferred as unlikely.
  const { startedAt } = state;

  /** Write a change to this run, or stop the pipeline if it was superseded. */
  const advance: Advance = async (change) => {
    const next = await updateRunningDeepDive(deps, startedAt, (s) => ({ ...change(s), updatedAt: now().toISOString() }));
    if (next === null) throw new SupersededError();
    return next;
  };

  try {
    const scanned = await scanStage(deps, await advance((s) => s), now, advance);
    const { summary } = scanned;
    let current = await backfillStage(deps, scanned.state, summary, now, advance);
    current = await draftStage(deps, current, summary, now, advance);
    current = await handoffStage(deps, current, summary, advance);
    logger.info(
      { startedAt, reviewTaskId: current.reviewTaskId, backfilled: current.backfilled, spendUsd: current.spendUsd },
      'deep-dive: drafts delivered',
    );
  } catch (err) {
    if (err instanceof SupersededError) {
      logger.info({ startedAt }, 'deep-dive: run superseded or finished elsewhere; stopping');
      return;
    }
    await recordFailure(deps, startedAt, err, now);
  }
}

/**
 * Stage 1: scan and store the summary, unless a stored summary already exists; then it is read
 * back and its shape checked, and a malformed one fails the run rather than reach later stages.
 */
async function scanStage(
  deps: RunDeps,
  state: DeepDiveState,
  now: () => Date,
  advance: Advance,
): Promise<{ state: DeepDiveState; summary: HistorySummary }> {
  const { logger } = deps;
  const stored = state.summaryPath === null ? null : await deps.workingDocsRepo.read(state.summaryPath);
  if (stored !== null) {
    logger.info({ summaryPath: state.summaryPath }, 'deep-dive: summary already stored; not rescanning');
    const summary = parseStoredSummary(stored.body);
    return { state: state.status === 'drafting' ? state : await advance((s) => ({ ...s, status: 'drafting' })), summary };
  }
  // A fresh summary means fresh contacts and drafts: what an earlier attempt recorded is dropped.
  if (state.status !== 'scanning') {
    state = await advance((s) => ({ ...s, status: 'scanning', summaryPath: null, backfilled: null, draftPaths: [] }));
  }

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
  const next = await advance((s) => ({
    ...s,
    status: 'drafting',
    summaryPath: SUMMARY_PATH,
    requests: result.coverage.requests,
    rateLimited: result.coverage.rateLimited,
  }));
  return { state: next, summary };
}

/** Stage 2: create contacts from the summary, once per run. */
async function backfillStage(
  deps: RunDeps,
  state: DeepDiveState,
  summary: HistorySummary,
  now: () => Date,
  advance: Advance,
): Promise<DeepDiveState> {
  const { logger } = deps;
  if (state.backfilled !== null) {
    logger.info({ backfilled: state.backfilled }, 'deep-dive: contacts already backfilled; skipping');
    return state;
  }
  const result = await withHeartbeat(deps, state.startedAt, now, () =>
    backfillContacts({ contactService: deps.contactService, logger }, summary),
  );
  logger.info(result, 'deep-dive: contacts backfilled');
  return advance((s) => ({ ...s, backfilled: result.created }));
}

/**
 * Stage 3: write the three drafts, one model call each. A draft this run already wrote (its path
 * in draftPaths, its doc still there) is skipped; an earlier run's draft at the same path is
 * replaced. Spend is recorded after every call, a failed one's included, before the run fails.
 */
async function draftStage(
  deps: RunDeps,
  state: DeepDiveState,
  summary: HistorySummary,
  now: () => Date,
  advance: Advance,
): Promise<DeepDiveState> {
  const { logger } = deps;
  const pending: DraftKind[] = [];
  for (const kind of DRAFT_KINDS) {
    const path = DRAFT_PATHS[kind];
    if (!state.draftPaths.includes(path) || (await deps.workingDocsRepo.read(path)) === null) pending.push(kind);
  }
  if (pending.length === 0) {
    logger.info('deep-dive: drafts already written; skipping');
    return state;
  }

  const inputs = await readDraftInputs(
    {
      workingDocsRepo: deps.workingDocsRepo,
      ...(deps.executiveProfile ? { executiveProfile: deps.executiveProfile } : {}),
      officeIdentity: deps.officeIdentity,
      readWorkingHours: deps.readWorkingHours,
    },
    summary,
  );
  // Built field by field: drafting must never be handed a mailbox client (see DraftDeps).
  const draftDeps: DraftDeps = {
    providerRouter: deps.providerRouter,
    modelRouter: deps.modelRouter,
    bus: deps.bus,
    estimateCost: deps.estimateCost,
    modelRegistry: deps.modelRegistry,
    logger,
  };
  const draft = deps.draft ?? draftDocuments;

  for (const kind of pending) {
    let result: Awaited<ReturnType<typeof draft>>;
    try {
      result = await withHeartbeat(deps, state.startedAt, now, () => draft(draftDeps, inputs, [kind]));
    } catch (err) {
      if (err instanceof DraftError && err.spendUsd > 0) {
        const spent = err.spendUsd;
        await advance((s) => ({ ...s, spendUsd: s.spendUsd + spent }));
      }
      throw err;
    }
    // Recorded first, whatever follows: the call is paid for. Also re-checks the run before the write.
    state = await advance((s) => ({ ...s, spendUsd: s.spendUsd + result.spendUsd }));
    const text = result.drafts[kind];
    if (text === undefined) throw new Error(`deep-dive: drafting returned no "${kind}" draft`);
    const path = DRAFT_PATHS[kind];
    await writeConsoleOnlyDoc(deps, path, DRAFT_DOC_TYPE, DRAFT_TITLES[kind], text);
    state = await advance((s) => ({ ...s, draftPaths: [...s.draftPaths.filter((p) => p !== path), path] }));
  }
  logger.info({ spendUsd: state.spendUsd, drafted: pending }, 'deep-dive: drafts written');
  return state;
}

/**
 * Run `fn` while touching updatedAt every heartbeat, so a long stage never looks stalled to the
 * watcher (STALL_MINUTES). A failed touch is logged and the stage goes on.
 */
async function withHeartbeat<T>(deps: RunDeps, startedAt: string, now: () => Date, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    updateRunningDeepDive(deps, startedAt, (s) => ({ ...s, updatedAt: now().toISOString() })).catch((err: unknown) => {
      deps.logger.warn({ err, startedAt }, 'deep-dive: could not record progress; the watcher may resume this run');
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
  await writeConsoleOnlyDoc(deps, SUMMARY_PATH, SUMMARY_DOC_TYPE, 'History summary', body);
}

/**
 * Create a durable doc owned by no task, or replace an earlier run's. Console-only: agents read
 * untrusted mail, so no agent's doc-write may rewrite what later stages and the principal trust.
 */
async function writeConsoleOnlyDoc(deps: RunDeps, path: string, type: string, title: string, body: string): Promise<void> {
  const frontmatter = { title, [EDITABLE_BY_KEY]: EDITABLE_BY_CONSOLE };
  const existing = await deps.workingDocsRepo.read(path);
  if (existing === null) {
    await deps.workingDocsRepo.create({ path, type, frontmatter, body, taskId: null });
    return;
  }
  const written = await deps.workingDocsRepo.update(path, { type, frontmatter, body, taskId: null, expectedVersion: existing.version });
  if (!written.ok) throw new Error(`deep-dive: ${path} changed while it was being replaced`);
}

const SUMMARY_ARRAYS = [
  'principalAddresses',
  'correspondents',
  'unopened',
  'handedOff',
  'recurringMeetings',
  'timeSpent',
  'voiceSample',
] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read a stored summary doc's body back. The doc is console-editable, so its shape is checked
 * (version, window, coverage, the lists later stages walk) and a bad one throws a clear error.
 */
export function parseStoredSummary(body: string): HistorySummary {
  const malformed = (why: string): Error => new Error(`deep-dive: the stored history summary is malformed (${why})`);
  const fenced = /^```json\r?\n([\s\S]*?)\r?\n```\s*$/.exec(body);
  if (!fenced) throw malformed('not a fenced JSON block');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1]!);
  } catch (err) {
    throw malformed(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(parsed)) throw malformed('not a JSON object');
  if (parsed.version !== 1) throw malformed(`unsupported version ${JSON.stringify(parsed.version)}`);
  const { window, coverage } = parsed;
  if (!isObject(window) || typeof window.from !== 'string' || typeof window.to !== 'string') throw malformed('window');
  if (!isObject(coverage) || typeof coverage.truncated !== 'boolean') throw malformed('coverage');
  if (!isObject(parsed.meetingShape)) throw malformed('meetingShape');
  for (const key of SUMMARY_ARRAYS) {
    const list = parsed[key];
    if (!Array.isArray(list)) throw malformed(`${key} is not a list`);
    if (key !== 'principalAddresses' && !list.every(isObject)) throw malformed(`${key} has a non-object entry`);
  }
  // Shape checked above: the fields every later stage reads are present.
  return parsed as unknown as HistorySummary;
}

/** The failure note: names the drafts already written, so they are still reviewed, not declined. */
export function failureNote(draftPaths: readonly string[]): string {
  if (draftPaths.length === 0) {
    return 'Deep dive failed: no drafts are coming from it; its Review topics can be declined';
  }
  return (
    `Deep dive failed after writing ${draftPaths.join(', ')}: review what was written; ` +
    'Review topics for anything missing can be declined'
  );
}

/**
 * Mark the run failed (only if it is still this run), then note it on the task the review would
 * go on (the open onboarding task, else this run's open review task) and wake the coordinator
 * there: the wake is what re-checks onboarding completion, which the run was holding.
 */
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
  let task: { id: string } | null;
  try {
    task = await findOpenOnboardingTask(deps.taskRepo);
    if (!task && marked.reviewTaskId !== null) {
      const review = await deps.taskRepo.getTask(marked.reviewTaskId);
      task = review && isOpenTask(review) ? review : null;
    }
  } catch (lookupErr) {
    logger.error({ err: lookupErr, startedAt }, 'deep-dive: could not look up the task to note the failure on; no failure notice sent');
    return;
  }
  if (!task) {
    logger.error({ startedAt }, 'deep-dive: run failed with no onboarding or review task open; no notice sent');
    return;
  }
  try {
    await noteAndWakeCoordinator(
      { taskRepo: deps.taskRepo, scheduler: deps.scheduler, logger },
      task,
      failureNote(marked.draftPaths),
    );
  } catch (noteErr) {
    logger.error({ err: noteErr, taskId: task.id }, 'deep-dive: could not note the failure or wake the coordinator');
  }
  if (deps.notifyOperator) {
    // The notifier never throws: it records its own note and logs a failed send.
    await deps.notifyOperator(task.id, 'deep_dive_failed');
  }
}
