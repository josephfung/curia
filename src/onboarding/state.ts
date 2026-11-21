// state.ts — onboarding run state, persisted in the config store (#2360).

import type { ConfigStore } from '../memory/config-store.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { TaskRow } from '../db/queries/tasks.js';
import type { MessagingRoute } from '../setup/setup-state.js';
import type { Logger } from '../logger.js';
import type { OperatorEvent } from './notify-operator.js';

export const ONBOARDING_NAMESPACE = 'onboarding';
export const ONBOARDING_STATE_KEY = 'state';
export const ONBOARDING_TASK_TAG = 'onboarding';

// Non-terminal task statuses (terminal: done, cancelled).
const OPEN_STATUSES = ['open', 'in_progress', 'waiting', 'blocked'];

export type OnboardingState = {
  taskId: string;
  startedAt: string;
  route: MessagingRoute;
  greetingSentAt: string | null;
  followUpsSent: number;
  lastFollowUpAt: string | null;
  lastPrincipalTurnAt: string | null;
  idleNudgeSentAt: string | null;
  operatorNotified: OperatorEvent[];
};

/** Read the onboarding state. Missing → null; malformed JSON → warn and null. */
export async function readOnboardingState(
  store: Pick<ConfigStore, 'get'>,
  logger?: Logger,
): Promise<OnboardingState | null> {
  const raw = await store.get(ONBOARDING_NAMESPACE, ONBOARDING_STATE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('onboarding state is not a JSON object');
    }
    return parsed as OnboardingState; // shape checked loosely; the store is written only by writeOnboardingState
  } catch (err) {
    logger?.warn({ err }, 'onboarding: state is malformed, treating as absent');
    return null;
  }
}

export async function writeOnboardingState(
  store: Pick<ConfigStore, 'set'>,
  s: OnboardingState,
): Promise<void> {
  await store.set(ONBOARDING_NAMESPACE, ONBOARDING_STATE_KEY, JSON.stringify(s));
}

/** The open parent onboarding task: tagged `onboarding`, no parent, non-terminal. */
export async function findOpenOnboardingTask(
  taskRepo: Pick<TaskRepo, 'listTasks'>,
): Promise<TaskRow | null> {
  const rows = await taskRepo.listTasks({
    tag: ONBOARDING_TASK_TAG,
    statuses: OPEN_STATUSES,
    limit: 100,
  });
  return rows.find((t) => !t.parentTaskId) ?? null;
}
