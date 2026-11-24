// state.ts — onboarding run state, persisted in the config store (#2360).

import type { Pool } from 'pg';
import type { ConfigStore } from '../memory/config-store.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { TaskRow } from '../db/queries/tasks.js';
import type { MessagingRoute } from '../settings/registry.js';
import type { Logger } from '../logger.js';
import type { OperatorEvent } from './notify-operator.js';
import { OPERATOR_EVENTS } from './notify-operator.js';
import { ONBOARDING_CREATED_BY } from './constants.js';
import { MESSAGING_ROUTES } from '../settings/registry.js';

export const ONBOARDING_NAMESPACE = 'onboarding';
export const ONBOARDING_STATE_KEY = 'state';
export const ONBOARDING_TASK_TAG = 'onboarding';

// Non-terminal task statuses (terminal: done, cancelled).
export const OPEN_STATUSES = ['open', 'in_progress', 'waiting', 'blocked'];

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
  /** The phone app invitation this run minted (app route); null or absent when it minted none. */
  invitationId?: string | null;
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
    (o.invitationId === undefined || isNullableString(o.invitationId)) &&
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

/**
 * Runs `fn` while holding the onboarding state lock. Every read-modify-write of the run state goes
 * through one (see {@link updateOnboardingState}), so the watcher, live principal turns, event
 * subscribers and the greeting record never write back a snapshot that misses another's change.
 */
export type OnboardingStateLock = <T>(fn: () => Promise<T>) => Promise<T>;

const STATE_LOCK_KEY = 'onboarding:state';
/** Longest a state update waits for another holder before failing (Postgres interval). */
const STATE_LOCK_TIMEOUT = '10s';

/**
 * The state lock across processes: a transaction-scoped Postgres advisory lock (same key hashing
 * as KnowledgeGraphStore.withAdvisoryLock) on its own connection, held while `fn` reads and writes
 * the config store on other connections. Callers in this process queue first, so they hold at most
 * one lock connection and cannot drain the pool `fn` needs. Share one instance per process.
 */
export function createOnboardingStateLock(pool: Pick<Pool, 'connect'>, logger: Logger): OnboardingStateLock {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const client = await pool.connect();
      // Set when ROLLBACK fails: the connection may still hold the lock, so destroy it.
      let discard: Error | undefined;
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('lock_timeout', $1, true)`, [STATE_LOCK_TIMEOUT]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [STATE_LOCK_KEY]);
        const out = await fn();
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          discard = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
          logger.error({ err: rollbackErr }, 'onboarding: state lock rollback failed — discarding the connection');
        }
        throw err;
      } finally {
        client.release(discard);
      }
    } finally {
      release();
    }
  };
}

export type OnboardingStateDeps = {
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  stateLock: OnboardingStateLock;
  logger?: Logger;
};

/**
 * The one read-modify-write of the run state: under the state lock, read the latest state and
 * apply `change`, which returns the next state or null to leave it as it is. Missing (or
 * malformed) state is never created here. Returns the state as it stands afterwards (null when
 * there is none) and whether it was written. A failed write throws.
 */
export function updateOnboardingState(
  deps: OnboardingStateDeps,
  change: (s: OnboardingState) => OnboardingState | null,
): Promise<{ state: OnboardingState | null; written: boolean }> {
  return deps.stateLock(async () => {
    const current = await readOnboardingState(deps.configStore, deps.logger);
    if (current === null) return { state: null, written: false };
    const next = change(current);
    if (next === null) return { state: current, written: false };
    await writeOnboardingState(deps.configStore, next);
    return { state: next, written: true };
  });
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
