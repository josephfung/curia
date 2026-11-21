// notify-operator-once.ts — notifyOperator, once per event per onboarding run (#2360).
//
// Kept apart from notify-operator.ts because state.ts imports OPERATOR_EVENTS from there; this
// file needs state.ts's writer, and one file doing both would be an import cycle.

import type { ConfigStore } from '../memory/config-store.js';
import { notifyOperator, type NotifyOperatorDeps, type OperatorEvent } from './notify-operator.js';
import { readOnboardingState, writeOnboardingState } from './state.js';

/**
 * `state.operatorNotified` records what was sent, so the event subscriber and the watcher do not
 * both notify. The latest state is read here, just before the write, so a concurrent change to
 * another field (greeting sent, a watcher update) is not clobbered by a stale caller snapshot.
 * The state is written first: a failed write skips the notice (logged), and a failed notice is
 * not retried, as notifyOperator never throws. No state, or state for another task: nothing is
 * sent. Returns whether a notice was recorded. Never throws.
 */
export async function notifyOperatorOnce(
  deps: NotifyOperatorDeps & { configStore: Pick<ConfigStore, 'get' | 'set'> },
  taskId: string,
  event: OperatorEvent,
  details?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const state = await readOnboardingState(deps.configStore, deps.logger);
    if (state === null || state.taskId !== taskId || state.operatorNotified.includes(event)) return false;
    await writeOnboardingState(deps.configStore, { ...state, operatorNotified: [...state.operatorNotified, event] });
  } catch (err) {
    deps.logger.error({ err, taskId, event }, 'onboarding: could not record the operator notice in state; not sending it');
    return false;
  }
  return notifyOperator(deps, taskId, event, details);
}
