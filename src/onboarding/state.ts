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
  /** Null only for a principal-initiated start on an install with no messaging route (pre-Setup installs). */
  route: MessagingRoute | null;
  greetingSentAt: string | null;
  followUpsSent: number;
  lastFollowUpAt: string | null;
  lastPrincipalTurnAt: string | null;
  idleNudgeSentAt: string | null;
  /** When the watcher re-woke the task because no greeting was recorded (optional: absent → never). */
  greetingNudgedAt?: string | null;
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
    (o.route === null || (typeof o.route === 'string' && (MESSAGING_ROUTES as readonly string[]).includes(o.route))) &&
    isNullableString(o.greetingSentAt) &&
    typeof o.followUpsSent === 'number' && Number.isFinite(o.followUpsSent) &&
    isNullableString(o.lastFollowUpAt) &&
    isNullableString(o.lastPrincipalTurnAt) &&
    isNullableString(o.idleNudgeSentAt) &&
    (o.greetingNudgedAt === undefined || isNullableString(o.greetingNudgedAt)) &&
    Array.isArray(o.operatorNotified) &&
    o.operatorNotified.every((e) => typeof e === 'string' && (OPERATOR_EVENTS as readonly string[]).includes(e))
  );
}

/**
 * Write the onboarding state. Throws when the store soft-rejects the write ({stored:false}), so a
 * caller never goes on as if a state it depends on were recorded.
 */
export async function writeOnboardingState(
  store: Pick<ConfigStore, 'set'>,
  s: OnboardingState,
): Promise<void> {
  await writeOnboardingStateRaw(store, JSON.stringify(s));
}

/** Write a raw state value (a failed start restores the one it read). Throws on {stored:false}. */
export async function writeOnboardingStateRaw(store: Pick<ConfigStore, 'set'>, raw: string): Promise<void> {
  const { stored } = await store.set(ONBOARDING_NAMESPACE, ONBOARDING_STATE_KEY, raw);
  if (!stored) throw new Error('onboarding: the config store rejected the onboarding state write');
}

/** Read the raw state value, unparsed (null when missing), so a failed start can restore it. */
export function readOnboardingStateRaw(store: Pick<ConfigStore, 'get'>): Promise<string | null> {
  return store.get(ONBOARDING_NAMESPACE, ONBOARDING_STATE_KEY);
}

/** Upper bound on the open onboarding rows read: the parent plus its open program-created subtasks. */
const OPEN_ONBOARDING_LIMIT = 500;

/** The open parent onboarding task: tagged `onboarding`, no parent, created by the onboarding program, non-terminal. */
export async function findOpenOnboardingTask(
  taskRepo: Pick<TaskRepo, 'listTasks'>,
): Promise<TaskRow | null> {
  // The model can tag any task `onboarding`, so the tag alone proves nothing: createdBy must match.
  // Filtered in the query, so tasks the model tagged cannot crowd the parent off the page.
  const rows = await taskRepo.listTasks({
    tag: ONBOARDING_TASK_TAG,
    statuses: OPEN_STATUSES,
    createdBy: ONBOARDING_CREATED_BY,
    limit: OPEN_ONBOARDING_LIMIT,
  });
  return rows.find((t) => !t.parentTaskId && t.createdBy === ONBOARDING_CREATED_BY) ?? null;
}
