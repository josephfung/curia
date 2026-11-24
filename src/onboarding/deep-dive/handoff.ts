// handoff.ts — the deep dive's last stage (#2362): hand the drafts to the Review session.
//
// The review goes on the onboarding task open *at hand-off time* (the run state names no
// onboarding task, so a restarted onboarding is handled). With none open (a re-run after
// onboarding) it goes on a standalone coordinator task tagged `deep-dive`, with the onboarding
// skill active, so the review works the same way. That task's id is recorded the moment it is
// created, so a resumed run reuses it rather than making a second. Then the Review session's
// topics are opened, the run is `delivered`, and the task gets a note naming the drafts and is
// woken. A note or wake that fails then leaves the run delivered and tells the operator
// (`deep_dive_delivery_failed`): the drafts exist, only the hand-off was lost.

import { DateTime } from 'luxon';
import { makeSystemOriginator } from '../../contacts/principal.js';
import { replaceActiveSkillsBlock } from '../../db/active-skills-progress.js';
import type { TaskRow } from '../../db/queries/tasks.js';
import { DEEP_DIVE_TASK_TAG, ONBOARDING_CREATED_BY, REVIEW_SESSION } from '../constants.js';
import { raiseOperatorNoticeOnce } from '../notify-operator-once.js';
import { findOpenOnboardingTask } from '../state.js';
import { isOpenTask } from '../subtasks.js';
import { noteAndWakeCoordinator } from '../subscribers.js';
import type { HistorySummary } from './history-summary.js';
import { DRAFT_KINDS } from './prompts.js';
import { DRAFT_PATHS } from './paths.js';
import type { Advance, RunDeps } from './run.js';
import type { DeepDiveState } from './state.js';

export { DEEP_DIVE_TASK_TAG, REVIEW_SESSION };
const ONBOARDING_SKILL = 'onboarding';

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
 * The task the review goes on: the open onboarding task, else this run's standalone review task
 * if it is still open, else a new standalone one (recorded in the run state at once).
 */
async function reviewTask(deps: RunDeps, state: DeepDiveState, advance: Advance): Promise<TaskRow> {
  const { taskRepo, logger } = deps;
  const onboarding = await findOpenOnboardingTask(taskRepo);
  if (onboarding) return onboarding;

  if (state.reviewTaskId !== null) {
    const prior = await taskRepo.getTask(state.reviewTaskId);
    if (prior && isOpenTask(prior)) {
      logger.info({ taskId: prior.id }, 'deep-dive: reusing the review task this run created');
      await activateOnboardingSkill(deps, prior.id);
      return prior;
    }
  }

  // Re-check before creating: a superseded run must not leave a review task behind.
  await advance((s) => s);
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

async function activateOnboardingSkill(deps: RunDeps, taskId: string): Promise<void> {
  const written = await deps.taskRepo.setActiveSkillsBlock(taskId, replaceActiveSkillsBlock([ONBOARDING_SKILL]));
  if ('ok' in written && !written.ok) {
    throw new Error(`deep-dive: could not set the active skill on review task ${taskId}: ${written.code}`);
  }
}
