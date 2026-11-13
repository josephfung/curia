// migrate-config-keys.ts — rename the pre-#2475 `default` key of ceo_inbox/sending to the
// migrated mailbox's id (#2475, D6), or drop it once that mailbox is gone (S-I1).
//
// The migrated mailbox is the registry row the flat migration created: the only one with no
// triage start (the console's add always sets it). That holds across boots, so an install migrated
// by an earlier release (whose migration now returns 'already') is renamed too (B1). Until the
// rename lands, send-level.ts applies a stored `default` key to that mailbox while it is the one
// live mailbox (legacyDefaultMailbox), so no boot step leaves an install on on_request.
import type { Logger } from '../logger.js';
import { SEND_SETTING_KEY, SEND_SETTING_NAMESPACE, type SendLevelMailbox } from '../skills/principal-send/send-level.js';

export interface SendingConfigStore {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<unknown>;
}

const LEGACY_KEY = 'default';

/**
 * 'renamed' when a `default` entry was moved to `defaultId`; 'nothing' otherwise (unset,
 * unparseable, no `default` key, or already renamed). Idempotent. An entry already stored under
 * `defaultId` wins, and the stale `default` is dropped. Other mailboxes' entries are kept.
 * Store errors propagate to the caller.
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
  await store.set(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY, JSON.stringify(next));
  return 'renamed';
}

/**
 * Drop the legacy `default` entry (no-op when absent). Called when the migrated mailbox is removed:
 * that entry was set for it, so it must not outlive it and be inherited by whichever mailbox is
 * added next as the sole one (R41, SF8). True when an entry was dropped. Store errors propagate.
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
  await store.set(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY, JSON.stringify(rest));
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
  };
  const run = async (): Promise<FlatOutcome> => {
    const outcome = await deps.migrate();
    await flush();
    return outcome;
  };
  return Object.assign(run, { flush });
}
