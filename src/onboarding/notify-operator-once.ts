// notify-operator-once.ts — notifyOperator, once per event per onboarding run (#2360).
//
// Kept apart from notify-operator.ts because state.ts imports OPERATOR_EVENTS from there; this
// file needs state.ts's writer, and one file doing both would be an import cycle.

import type { ConfigStore } from '../memory/config-store.js';
import { notifyOperator, type NotifyOperatorDeps, type OperatorEvent } from './notify-operator.js';
import { writeOnboardingState, type OnboardingState } from './state.js';

/**
 * `state.operatorNotified` records what was sent, so the event subscriber and the watcher do not
 * both notify. The state is written first: a failed write skips the notice (logged), and a failed
 * notice is not retried, as notifyOperator never throws. Returns whether a notice was sent.
 * Never throws.
 */
export async function notifyOperatorOnce(
  deps: NotifyOperatorDeps & { configStore: Pick<ConfigStore, 'set'> },
  state: OnboardingState,
  event: OperatorEvent,
  details?: Record<string, unknown>,
): Promise<boolean> {
  if (state.operatorNotified.includes(event)) return false;
  try {
    await writeOnboardingState(deps.configStore, { ...state, operatorNotified: [...state.operatorNotified, event] });
  } catch (err) {
    deps.logger.error({ err, taskId: state.taskId, event }, 'onboarding: could not record the operator notice in state; not sending it');
    return false;
  }
  await notifyOperator(deps, state.taskId, event, details);
  return true;
}
