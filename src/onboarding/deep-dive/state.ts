// state.ts — deep-dive run state, persisted in the config store (#2362).

import type { ConfigStore } from '../../memory/config-store.js';
import type { Logger } from '../../logger.js';
import { ONBOARDING_NAMESPACE, type OnboardingStateLock } from '../state.js';

export const DEEP_DIVE_KEY = 'deep_dive';

export type DeepDiveStatus = 'scanning' | 'drafting' | 'delivered' | 'failed';

const STATUSES: readonly DeepDiveStatus[] = ['scanning', 'drafting', 'delivered', 'failed'];

export type DeepDiveState = {
  status: DeepDiveStatus;
  startedAt: string;
  /** Touched on every stage change and on resume; the stall check reads it. */
  updatedAt: string;
  mailboxIds: string[];
  summaryPath: string | null;
  draftPaths: string[];
  reviewTaskId: string | null;
  backfilled: number | null;
  spendUsd: number;
  requests: number;
  rateLimited: number;
  error: string | null;
};

const isNullableString = (v: unknown): boolean => v === null || typeof v === 'string';
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');

function isDeepDiveState(v: object): v is DeepDiveState {
  const o = v as Record<string, unknown>;
  return (
    typeof o.status === 'string' && (STATUSES as readonly string[]).includes(o.status) &&
    typeof o.startedAt === 'string' &&
    typeof o.updatedAt === 'string' &&
    isStringArray(o.mailboxIds) &&
    isNullableString(o.summaryPath) &&
    isStringArray(o.draftPaths) &&
    isNullableString(o.reviewTaskId) &&
    (o.backfilled === null || isCount(o.backfilled)) &&
    isCount(o.spendUsd) &&
    isCount(o.requests) &&
    isCount(o.rateLimited) &&
    isNullableString(o.error)
  );
}

/** Read the deep-dive state. Missing → null; malformed → warn and null. */
export async function readDeepDiveState(
  store: Pick<ConfigStore, 'get'>,
  logger?: Logger,
): Promise<DeepDiveState | null> {
  const raw = await store.get(ONBOARDING_NAMESPACE, DEEP_DIVE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('deep-dive state is not a JSON object');
    }
    if (!isDeepDiveState(parsed)) throw new Error('deep-dive state has an unexpected shape');
    return parsed;
  } catch (err) {
    logger?.warn({ err }, 'deep-dive: state is malformed, treating as absent');
    return null;
  }
}

/** Write the deep-dive state. Throws when the store soft-rejects the write ({stored:false}). */
export async function writeDeepDiveState(store: Pick<ConfigStore, 'set'>, s: DeepDiveState): Promise<void> {
  const { stored } = await store.set(ONBOARDING_NAMESPACE, DEEP_DIVE_KEY, JSON.stringify(s));
  if (!stored) throw new Error('deep-dive: the config store rejected the deep-dive state write');
}

/** A run is in flight when it is scanning or drafting. */
export function isRunning(s: DeepDiveState | null): boolean {
  return s !== null && (s.status === 'scanning' || s.status === 'drafting');
}

/**
 * Change the run that started at `startedAt`, under the state lock, only while it is still that
 * run and still running. Returns the written state, or null when the run was superseded (a newer
 * forced run, or it already finished or failed) — the caller then stops without writing.
 */
export async function updateRunningDeepDive(
  deps: { configStore: Pick<ConfigStore, 'get' | 'set'>; stateLock: OnboardingStateLock; logger?: Logger },
  startedAt: string,
  change: (current: DeepDiveState) => DeepDiveState,
): Promise<DeepDiveState | null> {
  return deps.stateLock(async () => {
    const current = await readDeepDiveState(deps.configStore, deps.logger);
    if (current === null || current.startedAt !== startedAt || !isRunning(current)) return null;
    const next = change(current);
    await writeDeepDiveState(deps.configStore, next);
    return next;
  });
}
