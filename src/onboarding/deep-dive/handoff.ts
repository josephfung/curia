// handoff.ts — the deep dive's last stage (#2362): hand the drafts to the Review session.
//
// The review goes on the onboarding task open *at hand-off time* (the run state names no
// onboarding task, so a restarted onboarding is handled), unless its Review topics are all closed.
// Otherwise (a re-run after onboarding, or after its review) it goes on a standalone coordinator
// task tagged `deep-dive`, with the onboarding skill active, so the review works the same way.
// That task's id is recorded the moment it is created, so a resumed run reuses it rather than
// making a second; an earlier run's open review task is cancelled first. Then the Review session's
// topics are opened, the run is `delivered`, and the task gets a note naming the drafts and is
// woken. A note or wake that fails then leaves the run delivered and tells the operator
// (`deep_dive_delivery_failed`): the drafts exist, only the hand-off was lost.

import { DateTime } from 'luxon';
import { makeSystemOriginator } from '../../contacts/principal.js';
import { replaceActiveSkillsBlock } from '../../db/active-skills-progress.js';
import type { TaskRow } from '../../db/queries/tasks.js';
import {
  DEEP_DIVE_TASK_TAG,
  ONBOARDING_CREATED_BY,
  REVIEW_DOCUMENT_TOPICS,
  REVIEW_NEXT_STEP_TOPIC,
  REVIEW_SESSION,
} from '../constants.js';
import { raiseOperatorNoticeOnce } from '../notify-operator-once.js';
import { findOpenOnboardingTask, OPEN_STATUSES } from '../state.js';
import { isOpenTask, listChildren, topicSubtasks } from '../subtasks.js';
import { noteAndWakeCoordinator } from '../subscribers.js';
import type { HistorySummary } from './history-summary.js';
import { DRAFT_KINDS } from './prompts.js';
import { DRAFT_PATHS } from './paths.js';
import type { Advance, RunDeps } from './run.js';
import type { DeepDiveState } from './state.js';

export { DEEP_DIVE_TASK_TAG, REVIEW_SESSION };
const ONBOARDING_SKILL = 'onboarding';
/** Upper bound on earlier review tasks read; normally there is at most one. */
const STALE_REVIEW_LIMIT = 50;

/** A window bound as the principal's local date (the UTC date if the zone is unusable). */
function localDate(iso: string, timezone: string): string {
  return DateTime.fromISO(iso, { zone: timezone }).toISODate() ?? iso.slice(0, 10);
}

/** The progress note that tells the coordinator the drafts are ready. */
export function handoffNote(summary: HistorySummary, backfilled: number, timezone: string): string {
  const paths = DRAFT_KINDS.map((k) => DRAFT_PATHS[k]).join(', ');
  const coverage =
    `${localDate(summary.window.from, timezone)}–${localDate(summary.window.to, timezone)}` +
    (summary.coverage.truncated ? ', truncated' : '');
  return (
    `Deep-dive drafts ready: ${paths}. Contacts added: ${backfilled}. Coverage: ${coverage}. ` +
    'Copy each to a Google Doc and book the review (onboarding skill, "Deep-dive review").'
  );
}

export async function handoffStage(
  deps: RunDeps,
  state: DeepDiveState,
  summary: HistorySummary,
  advance: Advance,
): Promise<DeepDiveState> {
  const { logger } = deps;
  const parent = await reviewTask(deps, state, advance);

  const opened = await deps.onboardingService.openSession(parent, REVIEW_SESSION);
  if (!opened.ok) {
    // The operator edits the playbook. The drafts are still worth delivering: the note and the
    // onboarding skill's guidance carry the review without the session's topics.
    logger.warn(
      { taskId: parent.id, sessionIds: opened.sessionIds },
      'deep-dive: the playbook has no Review session; delivering the drafts without its topics',
    );
  }

  // Delivered before anyone is told. The write is guarded, so a superseded run stops here and never
  // announces its drafts; and a note or wake that fails after it cannot fail a run whose drafts are
  // written. That failure is a delivery problem: the operator hears deep_dive_delivery_failed.
  // Accepted gap: a process exit between this write and the note/wake loses the announcement (a
  // delivered run is not resumed, and no notice is sent). The order is kept because it is what
  // stops a superseded run from announcing its drafts.
  const delivered = await advance((s) => ({ ...s, status: 'delivered', reviewTaskId: parent.id }));
  try {
    await noteAndWakeCoordinator(
      { taskRepo: deps.taskRepo, scheduler: deps.scheduler, logger },
      parent,
      handoffNote(summary, state.backfilled ?? 0, deps.timezone()),
    );
  } catch (err) {
    logger.error({ err, taskId: parent.id }, 'deep-dive: drafts written, but the ready note or the coordinator wake failed');
    // Once per task, the same record the tool checks, so the model cannot email it a second time.
    // Never throws: a notice it could not record or send is logged there.
    await raiseOperatorNoticeOnce(
      {
        taskRepo: deps.taskRepo,
        logger,
        configStore: deps.configStore,
        stateLock: deps.stateLock,
        ...(deps.notifyOperator ? { notifier: deps.notifyOperator } : {}),
      },
      parent.id,
      'deep_dive_delivery_failed',
    );
  }
  return delivered;
}

/**
 * The task the review goes on: the open onboarding task while its Review topics are still to come
 * (none opened yet, or one still open), else this run's standalone review task if it is still open,
 * else a new standalone one (recorded in the run state at once). Before a new one is created, an
 * earlier run's open review task is cancelled: its topics may be half-closed against older drafts.
 */
async function reviewTask(deps: RunDeps, state: DeepDiveState, advance: Advance): Promise<TaskRow> {
  const { taskRepo, logger } = deps;
  const onboarding = await findOpenOnboardingTask(taskRepo);
  if (onboarding) {
    if (await reviewStillAhead(deps, onboarding.id)) return onboarding;
    // openSession never reopens a closed topic, so drafts handed to this task would land on
    // finished topics and the wake would complete onboarding instead of reviewing them.
    logger.info({ taskId: onboarding.id }, 'deep-dive: onboarding\'s Review topics are all closed; using a standalone review task');
  }

  if (state.reviewTaskId !== null) {
    const prior = await taskRepo.getTask(state.reviewTaskId);
    if (prior && isOpenTask(prior)) {
      logger.info({ taskId: prior.id }, 'deep-dive: reusing the review task this run created');
      await activateOnboardingSkill(deps, prior.id);
      return prior;
    }
  }

  // Re-check before creating: a superseded run must not leave a review task behind, nor cancel one.
  await advance((s) => s);
  await cancelStaleReviewTasks(deps);
  const created = await taskRepo.createTask({
    agentId: 'coordinator',
    title: 'Review your deep-dive drafts',
    tags: [DEEP_DIVE_TASK_TAG],
    createdBy: ONBOARDING_CREATED_BY,
    source: 'scheduler',
    owner: 'curia',
    status: 'open',
    originator: makeSystemOriginator(),
  });
  // Recorded before anything else can fail, so a resume reuses this task.
  await advance((s) => ({ ...s, reviewTaskId: created.id }));
  logger.info({ taskId: created.id }, 'deep-dive: no onboarding open; created a standalone review task');
  await activateOnboardingSkill(deps, created.id);
  return created;
}

/**
 * Whether the onboarding task's Review document topics are still to come: none opened, or one open.
 * A playbook seeded before the document topics existed (walk-drafts) is judged on its other Review
 * topics, as the onboarding-progress tool completes a standalone review task on them.
 */
async function reviewStillAhead(deps: RunDeps, onboardingTaskId: string): Promise<boolean> {
  const review = topicSubtasks(await listChildren(deps.taskRepo, onboardingTaskId), deps.logger).filter(
    (t) => t.sessionId === REVIEW_SESSION,
  );
  let deciding = review.filter((t) => (REVIEW_DOCUMENT_TOPICS as readonly string[]).includes(t.topicId));
  if (deciding.length === 0) deciding = review.filter((t) => t.topicId !== REVIEW_NEXT_STEP_TOPIC);
  return deciding.length === 0 || deciding.some((t) => isOpenTask(t.task));
}

/**
 * Cancel every open review task an earlier deep dive created (this run's own was reused above, so
 * any found here is stale). Cancelling also cancels its open topic subtasks (task-repo reconciles
 * a terminal parent's children). A cancel that fails is logged and skipped: the old task staying
 * open is the state before this fix, and it must not cost the principal these drafts.
 */
async function cancelStaleReviewTasks(deps: RunDeps): Promise<void> {
  const { taskRepo, logger } = deps;
  const stale = await taskRepo.listTasks({
    tag: DEEP_DIVE_TASK_TAG,
    statuses: OPEN_STATUSES,
    createdBy: ONBOARDING_CREATED_BY,
    limit: STALE_REVIEW_LIMIT,
  });
  // The model can tag a task deep-dive; the createdBy filter is what makes it the program's.
  for (const task of stale.filter((t) => !t.parentTaskId && t.createdBy === ONBOARDING_CREATED_BY)) {
    try {
      await taskRepo.updateTask(task.id, { status: 'cancelled', progressNote: 'Superseded by a new deep dive.' });
      logger.info({ taskId: task.id }, 'deep-dive: cancelled an earlier run\'s review task');
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'deep-dive: could not cancel an earlier run\'s review task; it stays open');
    }
  }
}

async function activateOnboardingSkill(deps: RunDeps, taskId: string): Promise<void> {
  const written = await deps.taskRepo.setActiveSkillsBlock(taskId, replaceActiveSkillsBlock([ONBOARDING_SKILL]));
  if ('ok' in written && !written.ok) {
    throw new Error(`deep-dive: could not set the active skill on review task ${taskId}: ${written.code}`);
  }
}
