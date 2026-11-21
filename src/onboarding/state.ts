// state.ts — onboarding run state, persisted in the config store (#2360).

import type { ConfigStore } from '../memory/config-store.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { TaskRow } from '../db/queries/tasks.js';
import type { MessagingRoute } from '../setup/setup-state.js';
import type { Logger } from '../logger.js';
import type { OperatorEvent } from './notify-operator.js';
import { OPERATOR_EVENTS } from './notify-operator.js';
import { ONBOARDING_CREATED_BY } from './constants.js';
import { MESSAGING_ROUTES } from '../setup/setup-state.js';

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
    if (!isOnboardingState(parsed)) throw new Error('onboarding state has an unexpected shape');
    return parsed;
  } catch (err) {
    logger?.warn({ err }, 'onboarding: state is malformed, treating as absent');
    return null;
  }
}

const isNullableString = (v: unknown): boolean => v === null || typeof v === 'string';

function isOnboardingState(v: object): v is OnboardingState {
  const o = v as Record<string, unknown>;
  return (
    typeof o.taskId === 'string' &&
    typeof o.startedAt === 'string' &&
    typeof o.route === 'string' && (MESSAGING_ROUTES as readonly string[]).includes(o.route) &&
    isNullableString(o.greetingSentAt) &&
    typeof o.followUpsSent === 'number' && Number.isFinite(o.followUpsSent) &&
    isNullableString(o.lastFollowUpAt) &&
    isNullableString(o.lastPrincipalTurnAt) &&
    isNullableString(o.idleNudgeSentAt) &&
    Array.isArray(o.operatorNotified) &&
    o.operatorNotified.every((e) => typeof e === 'string' && (OPERATOR_EVENTS as readonly string[]).includes(e))
  );
}

export async function writeOnboardingState(
  store: Pick<ConfigStore, 'set'>,
  s: OnboardingState,
): Promise<void> {
  await store.set(ONBOARDING_NAMESPACE, ONBOARDING_STATE_KEY, JSON.stringify(s));
}

/** The open parent onboarding task: tagged `onboarding`, no parent, created by the onboarding program, non-terminal. */
export async function findOpenOnboardingTask(
  taskRepo: Pick<TaskRepo, 'listTasks'>,
): Promise<TaskRow | null> {
  const rows = await taskRepo.listTasks({
    tag: ONBOARDING_TASK_TAG,
    statuses: OPEN_STATUSES,
    limit: 100,
  });
  // The model can tag any task `onboarding`, so the tag alone proves nothing: createdBy must match.
  return rows.find((t) => !t.parentTaskId && t.createdBy === ONBOARDING_CREATED_BY) ?? null;
}
