// notify-operator-once.ts — notifyOperator, once per event per onboarding run (#2360).
//
// Kept apart from notify-operator.ts because state.ts imports OPERATOR_EVENTS from there; this
// file needs state.ts's writer, and one file doing both would be an import cycle.

import type { TaskRepo } from '../db/task-repo.js';
import {
  notifyOperator,
  operatorNoticeNote,
  type NotifyOperatorDeps,
  type OperatorEvent,
  type OperatorNotice,
  type OperatorNoticeResult,
} from './notify-operator.js';
import { type OnboardingState, type OnboardingStateDeps, readOnboardingState, updateOnboardingState } from './state.js';

/**
 * `state.operatorNotified` records what was sent, so the event subscriber and the watcher do not
 * both notify. The record is one atomic state update (updateOnboardingState), so a concurrent
 * change to another field (greeting sent, a principal turn, a watcher update) is never clobbered.
 * `stillApplies`, when given, is checked on the latest state inside that update: a caller that
 * decided on an earlier read (the watcher) sends nothing if that decision no longer holds.
 * The state is written first: a failed write skips the notice (logged). A notice whose task note
 * could not be written gives the event back, so it can be raised again. No state, or state for
 * another task: nothing is sent. Returns whether a notice was recorded. Never throws.
 */
export async function notifyOperatorOnce(
  deps: NotifyOperatorDeps & Pick<OnboardingStateDeps, 'configStore' | 'stateLock'>,
  taskId: string,
  event: OperatorEvent,
  notice?: OperatorNotice,
  stillApplies?: (s: OnboardingState) => boolean,
): Promise<boolean> {
  try {
    const { written } = await updateOnboardingState(deps, (state) => {
      if (state.taskId !== taskId || state.operatorNotified.includes(event)) return null;
      if (stillApplies && !stillApplies(state)) return null;
      return { ...state, operatorNotified: [...state.operatorNotified, event] };
    });
    if (!written) return false;
  } catch (err) {
    deps.logger.error({ err, taskId, event }, 'onboarding: could not record the operator notice in state; not sending it');
    return false;
  }
  // The injected notifier (index.ts binds the gateway) takes precedence over the bare deps;
  // without one the notice is still recorded, and holding no gateway means nobody is emailed.
  const result: OperatorNoticeResult = deps.notifier
    ? await deps.notifier(taskId, event, notice)
    : await notifyOperator(deps, taskId, event, notice);
  if (!result.recorded) {
    // Nothing was recorded and nothing was sent (#2710 review): give the event back, so a retry
    // (the tool asks the model for one) raises it rather than answering "already raised".
    await releaseEventClaim(deps, taskId, event);
    return false;
  }
  return true;
}

/** Undo the claim on an event whose notice was never recorded. Best-effort: logged on failure. */
async function releaseEventClaim(
  deps: Pick<NotifyOperatorDeps, 'logger'> & Pick<OnboardingStateDeps, 'configStore' | 'stateLock'>,
  taskId: string,
  event: OperatorEvent,
): Promise<void> {
  try {
    await updateOnboardingState(deps, (state) => {
      if (state.taskId !== taskId || !state.operatorNotified.includes(event)) return null;
      return { ...state, operatorNotified: state.operatorNotified.filter((e) => e !== event) };
    });
  } catch (err) {
    deps.logger.error({ err, taskId, event }, 'onboarding: could not release an unrecorded operator notice; it will not be raised again this run');
  }
}

export type RaiseOnceDeps = NotifyOperatorDeps &
  Pick<OnboardingStateDeps, 'configStore' | 'stateLock'> & { taskRepo: Pick<TaskRepo, 'updateTask' | 'getTask'> };

/**
 * Raise a notice at most once per event per task, wherever it comes from (the tool, or the deep
 * dive's own hand-off). On the onboarding run's task the run state is the record (notifyOperatorOnce).
 * On any other task (a standalone deep-dive review task, #2362, which no run owns) the record is the
 * task's own "Operator notice: <event>" progress note, checked and written under the same state
 * lock, so two raisers cannot both send. That lock is held while the notice is sent. Never throws.
 */
export async function raiseOperatorNoticeOnce(
  deps: RaiseOnceDeps,
  taskId: string,
  event: OperatorEvent,
  notice: OperatorNotice = {},
): Promise<{ alreadyRaised: boolean; recorded: boolean }> {
  let state: OnboardingState | null;
  try {
    state = await readOnboardingState(deps.configStore, deps.logger);
  } catch (err) {
    deps.logger.error({ err, taskId, event }, 'onboarding: could not read the run state; not sending the operator notice');
    return { alreadyRaised: false, recorded: false };
  }
  if (state !== null && state.taskId === taskId) {
    // Checked up front so a caller can say "already raised"; notifyOperatorOnce re-checks under the lock.
    if (state.operatorNotified.includes(event)) return { alreadyRaised: true, recorded: true };
    return { alreadyRaised: false, recorded: await notifyOperatorOnce(deps, taskId, event, notice) };
  }
  try {
    return await deps.stateLock(async () => {
      const task = await deps.taskRepo.getTask(taskId);
      if (task === null) {
        deps.logger.warn({ taskId, event }, 'onboarding: no such task to record the operator notice on; not sending it');
        return { alreadyRaised: false, recorded: false };
      }
      if (hasNote(task.progress, operatorNoticeNote(event))) return { alreadyRaised: true, recorded: true };
      const result = deps.notifier ? await deps.notifier(taskId, event, notice) : await notifyOperator(deps, taskId, event, notice);
      return { alreadyRaised: false, recorded: result.recorded };
    });
  } catch (err) {
    deps.logger.error({ err, taskId, event }, 'onboarding: could not check or record the operator notice on its task');
    return { alreadyRaised: false, recorded: false };
  }
}

/** Whether a task's progress notes include `text`. */
function hasNote(progress: Record<string, unknown> | null, text: string): boolean {
  const notes = progress?.['notes'];
  return Array.isArray(notes) && notes.some((n: unknown) =>
    typeof n === 'object' && n !== null && (n as Record<string, unknown>)['note'] === text);
}
