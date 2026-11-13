// migrate-config-keys.ts — rename the pre-#2475 `default` key of ceo_inbox/sending to the
// migrated default mailbox's id (#2475, D6). Run at boot once a real default id exists.
//
// Until it runs, send-level.ts still applies a stored `default` key to the default mailbox
// (createSendLevelReader's defaultMailboxId), so no boot step leaves an install on on_request.
import type { Logger } from '../logger.js';
import { SEND_SETTING_KEY, SEND_SETTING_NAMESPACE } from '../skills/principal-send/send-level.js';

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
 * Drop the legacy `default` entry (no-op when absent). Called when a mailbox is removed: that
 * entry was set for the install's one migrated mailbox, so it must not outlive it and be
 * inherited by whichever mailbox is added next as the sole one (R41). Store errors propagate.
 */
export async function dropLegacyDefaultKey(store: SendingConfigStore, logger: Logger): Promise<void> {
  const raw = await store.get(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY);
  if (raw === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Not ours to repair; the reader flags it.
    logger.warn({ errName: err instanceof Error ? err.name : typeof err }, 'ceo_inbox/sending is not valid JSON; the legacy default key is not dropped');
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
  const { [LEGACY_KEY]: legacy, ...rest } = parsed as Record<string, unknown>;
  if (legacy === undefined) return;
  await store.set(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY, JSON.stringify(rest));
}

type FlatOutcome = 'migrated' | 'already' | 'nothing' | 'deferred';

/**
 * Wraps the flat-mailbox migration so the send-level rename follows it wherever it returns
 * 'migrated' (boot and the health retry), onto the id that migration created (R41): the level was
 * set for that one mailbox, so it is never bound to "the current default". The id is read right
 * after the migration, when it is the only live mailbox; with any other count nothing is guessed.
 * At boot the config store does not exist yet: the id waits for `flush()`, called once it does.
 */
export function renameSendingKeyAfterMigration(deps: {
  migrate: () => Promise<FlatOutcome>;
  liveIds: () => Promise<readonly string[]>;
  store: () => SendingConfigStore | undefined;
  logger: Logger;
}): (() => Promise<FlatOutcome>) & { flush: () => Promise<void> } {
  let pendingId: string | undefined;
  const flush = async (): Promise<void> => {
    const store = deps.store();
    if (!pendingId || !store) return;
    const id = pendingId;
    try {
      if ((await migrateSendingKey(store, id, deps.logger)) === 'renamed') {
        deps.logger.info({ mailboxId: id }, 'Renamed the default send-level key to the migrated mailbox id');
      }
      pendingId = undefined;
    } catch (err) {
      // Kept pending for the next flush; until then the legacy key applies while this is the only mailbox.
      deps.logger.warn({ err }, 'Could not rename the ceo_inbox/sending default key; the legacy key still applies');
    }
  };
  const run = async (): Promise<FlatOutcome> => {
    const outcome = await deps.migrate();
    // A rename that failed earlier is retried on the next run, not dropped.
    if (outcome !== 'migrated') await flush();
    if (outcome === 'migrated') {
      try {
        const ids = await deps.liveIds();
        if (ids.length === 1) pendingId = ids[0];
      } catch (err) {
        deps.logger.warn({ err }, 'Could not read the migrated mailbox id; the send-level key is not renamed');
      }
      await flush();
    }
    return outcome;
  };
  return Object.assign(run, { flush });
}
