// notify-operator-once.ts — notifyOperator, once per event per onboarding run (#2360).
//
// Kept apart from notify-operator.ts because state.ts imports OPERATOR_EVENTS from there; this
// file needs state.ts's writer, and one file doing both would be an import cycle.

import { notifyOperator, type NotifyOperatorDeps, type OperatorEvent, type OperatorNotice, type OperatorNoticeResult } from './notify-operator.js';
import { type OnboardingState, type OnboardingStateDeps, updateOnboardingState } from './state.js';

/**
 * `state.operatorNotified` records what was sent, so the event subscriber and the watcher do not
 * both notify. The record is one atomic state update (updateOnboardingState), so a concurrent
 * change to another field (greeting sent, a principal turn, a watcher update) is never clobbered.
 * `stillApplies`, when given, is checked on the latest state inside that update: a caller that
 * decided on an earlier read (the watcher) sends nothing if that decision no longer holds.
 * The state is written first: a failed write skips the notice (logged), and a failed notice is
 * not retried, as notifyOperator never throws. No state, or state for another task: nothing is
 * sent. Returns whether a notice was recorded. Never throws.
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
  await recordNoticeOutcome(deps, taskId, event, result.emailed);
  return result.recorded;
}

/**
 * Record whether the notice was actually emailed, next to the "raised" record (#2710). The run
 * state must not claim the operator heard it when the send failed; the send itself is not
 * retried within the run (the notification path would repeat on the next run, and a retry here
 * would race the same bus). Best-effort: a state write that fails is logged, and the notice is
 * still raised.
 */
async function recordNoticeOutcome(
  deps: Pick<NotifyOperatorDeps, 'logger'> & Pick<OnboardingStateDeps, 'configStore' | 'stateLock'>,
  taskId: string,
  event: OperatorEvent,
  delivered: boolean,
): Promise<void> {
  try {
    await updateOnboardingState(deps, (state) => {
      if (state.taskId !== taskId) return null;
      const failed = new Set(state.operatorNoticeFailed ?? []);
      if (delivered) {
        if (!failed.delete(event)) return null;
      } else {
        if (failed.has(event)) return null;
        failed.add(event);
      }
      return { ...state, operatorNoticeFailed: [...failed] };
    });
  } catch (err) {
    deps.logger.warn({ err, taskId, event, delivered }, 'onboarding: could not record whether the operator notice was emailed');
  }
}
