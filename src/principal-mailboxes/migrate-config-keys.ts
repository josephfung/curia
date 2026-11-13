// migrate-config-keys.ts — rename the pre-#2475 `default` key of ceo_inbox/sending to the
// migrated mailbox's id (#2475, D6), or drop it once that mailbox is gone (S-I1). Also moves the
// pre-#2475 global sent-observe and learning-state keys to that mailbox's keys (D8, R60).
//
// The migrated mailbox is the registry row the flat migration created: the only one with no
// triage start (the console's add always sets it). That holds across boots, so an install migrated
// by an earlier release (whose migration now returns 'already') is renamed too (B1). Until the
// rename lands, send-level.ts applies a stored `default` key to that mailbox while it is the one
// live mailbox (legacyDefaultMailbox), so no boot step leaves an install on on_request.
import type { Logger } from '../logger.js';
import { PER_MAILBOX_STATE_NAMES, STATE_NAMESPACE, globalStateKey, mailboxStateKey } from './state-keys.js';
import { grantSafeErrorFields } from './error-fields.js';
import { SEND_SETTING_KEY, SEND_SETTING_NAMESPACE, type SendLevelMailbox } from '../skills/principal-send/send-level.js';

export interface SendingConfigStore {
  get(namespace: string, key: string): Promise<string | null>;
  /** ConfigStore.set: a soft rejection resolves `{ stored: false, action }` without throwing. */
  set(namespace: string, key: string, value: string): Promise<{ stored: boolean; action?: string }>;
}

/** Thrown when the store declined a write, so the caller's error and retry path handles it. */
export class SendingKeyNotStoredError extends Error {
  constructor(action: string | undefined) {
    super(`ceo_inbox/sending write was not stored (${action ?? 'no action'})`);
    this.name = 'SendingKeyNotStoredError';
  }
}

async function writeOrThrow(store: SendingConfigStore, value: string): Promise<void> {
  const result = await store.set(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY, value);
  if (!result.stored) throw new SendingKeyNotStoredError(result.action);
}

const LEGACY_KEY = 'default';

/**
 * 'renamed' when a `default` entry was moved to `defaultId`; 'nothing' otherwise (unset,
 * unparseable, no `default` key, or already renamed). Idempotent. An entry already stored under
 * `defaultId` wins, and the stale `default` is dropped. Other mailboxes' entries are kept.
 * Store errors, and a write the store declined, propagate to the caller.
 */
export async function migrateSendingKey(store: SendingConfigStore, defaultId: string, logger: Logger): Promise<'renamed' | 'nothing'> {
  if (defaultId === LEGACY_KEY) return 'nothing';
  const raw = await store.get(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY);
  if (raw === null) return 'nothing';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Not ours to repair: the reader flags an unparseable value on every read.
    logger.warn({ errName: err instanceof Error ? err.name : typeof err }, 'ceo_inbox/sending is not valid JSON; the default key is not renamed');
    return 'nothing';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'nothing';
  const levels = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(levels, LEGACY_KEY)) return 'nothing';
  const { [LEGACY_KEY]: legacy, ...rest } = levels;
  const next = Object.prototype.hasOwnProperty.call(rest, defaultId) ? rest : { ...rest, [defaultId]: legacy };
  await writeOrThrow(store, JSON.stringify(next));
  return 'renamed';
}

/**
 * Drop the legacy `default` entry (no-op when absent). Called when the migrated mailbox is removed:
 * that entry was set for it, so it must not outlive it and be inherited by whichever mailbox is
 * added next as the sole one (R41, SF8). True when an entry was dropped. Store errors, and a declined write, propagate.
 */
export async function dropLegacyDefaultKey(store: SendingConfigStore, logger: Logger): Promise<boolean> {
  const raw = await store.get(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY);
  if (raw === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Not ours to repair; the reader flags it.
    logger.warn({ errName: err instanceof Error ? err.name : typeof err }, 'ceo_inbox/sending is not valid JSON; the legacy default key is not dropped');
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  if (!Object.prototype.hasOwnProperty.call(parsed, LEGACY_KEY)) return false;
  const rest: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  delete rest[LEGACY_KEY];
  await writeOrThrow(store, JSON.stringify(rest));
  logger.info('Dropped the legacy default send-level key: the mailbox it was set for is gone');
  return true;
}

/** True when the stored value is an object that still has a `default` key. Never throws. */
function hasLegacyKey(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && Object.prototype.hasOwnProperty.call(parsed, LEGACY_KEY);
  } catch {
    // Unparseable: migrateSendingKey and dropLegacyDefaultKey warn about it; nothing to do here.
    return false;
  }
}

/**
 * Bring a leftover `default` key in line with the registry (B1, S-I1): rename it to the migrated
 * mailbox while that mailbox is live; drop it once that mailbox is gone and another is live; leave
 * it while the deferred fallback is served (it is that mailbox's level) or no mailbox is live.
 * Store and registry errors propagate.
 */
export async function reconcileLegacySendingKey(deps: {
  store: SendingConfigStore;
  mailboxes: readonly SendLevelMailbox[];
  fallbackActive: boolean;
  logger: Logger;
}): Promise<'renamed' | 'dropped' | 'nothing'> {
  const { store, mailboxes, logger } = deps;
  if (deps.fallbackActive || mailboxes.length === 0) return 'nothing';
  if (!hasLegacyKey(await store.get(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY))) return 'nothing';
  const migrated = mailboxes.find((m) => m.triageStartAt === null);
  if (migrated) return migrateSendingKey(store, migrated.id, logger);
  return (await dropLegacyDefaultKey(store, logger)) ? 'dropped' : 'nothing';
}

/**
 * Move each pre-#2475 global per-mailbox key (`sent_observe.<name>`: the watermark, idle backoff,
 * backfill and held-since state, and the matched-draft / asked-task / completion-candidate state)
 * to `sent_observe.<migratedId>.<name>` (D8, R60). `completion_digest`, its high-water mark and
 * `voice_learn.*` are not grant-scoped and stay where they are.
 *
 * Copy then clear: the global key is overwritten with '' (the config store has no delete; every
 * reader treats '' as unset) only after the copy landed. Idempotent: a global key that is unset or
 * already cleared is skipped, and a value already stored for the mailbox wins over the global one,
 * which is then cleared. Returns how many global keys were cleared. Store errors propagate.
 */
export async function migrateLearningKeys(store: SendingConfigStore, migratedId: string, logger: Logger): Promise<number> {
  let cleared = 0;
  for (const name of PER_MAILBOX_STATE_NAMES) {
    const globalKey = globalStateKey(name);
    const globalValue = await store.get(STATE_NAMESPACE, globalKey);
    if (globalValue === null || globalValue === '') continue;
    const ownKey = mailboxStateKey(migratedId, name);
    const own = await store.get(STATE_NAMESPACE, ownKey);
    if (own === null || own === '') {
      const res = await store.set(STATE_NAMESPACE, ownKey, globalValue);
      if (typeof res === 'object' && res !== null && (res as { stored?: unknown }).stored === false) {
        // Soft-rejected: keep the global key (readers still honour it for this mailbox); retried next boot.
        logger.warn({ name }, 'Could not copy a sent-observe state key to the migrated mailbox; the global key is kept and retried at the next boot');
        continue;
      }
    }
    const clear = await store.set(STATE_NAMESPACE, globalKey, '');
    if (typeof clear === 'object' && clear !== null && (clear as { stored?: unknown }).stored === false) {
      logger.warn({ name }, 'Could not clear a migrated sent-observe global key; retried at the next boot');
      continue;
    }
    cleared += 1;
  }
  return cleared;
}

/**
 * Run `migrateLearningKeys` for the migrated mailbox: the live row with no triage start, found the
 * way the send-level rename finds it. Does nothing while the fallback is served or when no migrated
 * mailbox is live ('no_target': the global keys stay where they are; the caller logs it once).
 */
export async function reconcileLearningKeys(deps: {
  store: SendingConfigStore;
  mailboxes: readonly SendLevelMailbox[];
  fallbackActive: boolean;
  logger: Logger;
}): Promise<'moved' | 'nothing' | 'no_target'> {
  if (deps.fallbackActive || deps.mailboxes.length === 0) return 'nothing';
  const migrated = deps.mailboxes.find((m) => m.triageStartAt === null);
  if (!migrated) return 'no_target';
  const cleared = await migrateLearningKeys(deps.store, migrated.id, deps.logger);
  return cleared > 0 ? 'moved' : 'nothing';
}

type FlatOutcome = 'migrated' | 'already' | 'nothing' | 'deferred';

/**
 * Wraps the flat-mailbox migration so the legacy send-level key is reconciled after every run, at
 * boot and in the health retry, whatever the migration returned (B1: an install migrated by an
 * earlier release returns 'already' on every boot). The rename targets the migrated mailbox (R41,
 * S-I1), never "the current default" or "any single live mailbox". At boot the config store does not
 * exist yet: `flush()` reconciles once it does, and a failure is retried by the next run or boot.
 */
export function renameSendingKeyAfterMigration(deps: {
  migrate: () => Promise<FlatOutcome>;
  mailboxes: () => Promise<readonly SendLevelMailbox[]>;
  isFallbackActive: () => Promise<boolean>;
  store: () => SendingConfigStore | undefined;
  logger: Logger;
}): (() => Promise<FlatOutcome>) & { flush: () => Promise<void> } {
  let toldNoStore = false;
  let toldNoTarget = false;
  const flush = async (): Promise<void> => {
    const store = deps.store();
    if (!store) {
      // Expected at boot (the store comes later and flushes then); said once, not per run (SF17).
      if (!toldNoStore) deps.logger.info('Send-level key check waits for the config store');
      toldNoStore = true;
      return;
    }
    try {
      const outcome = await reconcileLegacySendingKey({
        store, mailboxes: await deps.mailboxes(), fallbackActive: await deps.isFallbackActive(), logger: deps.logger,
      });
      if (outcome === 'renamed') deps.logger.info('Renamed the default send-level key to the migrated mailbox id');
    } catch (err) {
      // Retried on the next run or boot; until then the legacy key applies only to the migrated sole mailbox.
      deps.logger.warn({ errName: err instanceof Error ? err.name : typeof err }, 'Could not reconcile the ceo_inbox/sending default key; it is retried at the next boot');
    }
    // Same wiring, separate failure: the sent-observe and learning-state keys follow the same mailbox
    // (R60). Until they move, the readers honour the global keys for that mailbox.
    try {
      const outcome = await reconcileLearningKeys({
        store, mailboxes: await deps.mailboxes(), fallbackActive: await deps.isFallbackActive(), logger: deps.logger,
      });
      if (outcome === 'moved') deps.logger.info('Moved the sent-observe and learning-state keys to the migrated mailbox');
      if (outcome === 'no_target' && !toldNoTarget) {
        toldNoTarget = true;
        deps.logger.info('No migrated mailbox is live; the global sent-observe keys are left in place');
      }
    } catch (err) {
      deps.logger.warn(grantSafeErrorFields(err), 'Could not move the sent-observe keys to the migrated mailbox; retried at the next boot');
    }
  };
  const run = async (): Promise<FlatOutcome> => {
    const outcome = await deps.migrate();
    await flush();
    return outcome;
  };
  return Object.assign(run, { flush });
}
