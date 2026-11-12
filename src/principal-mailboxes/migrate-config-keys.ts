// migrate-config-keys.ts — rename the pre-#2475 `default` key of ceo_inbox/sending to the
// migrated default mailbox's id (#2475, D6). Run at boot once a real default id exists.
//
// Until it runs, send-level.ts still applies a stored `default` key to the default mailbox
// (createSendLevelReader's defaultMailboxId), so no boot step leaves an install on on_request.
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
export async function migrateSendingKey(store: SendingConfigStore, defaultId: string): Promise<'renamed' | 'nothing'> {
  if (defaultId === LEGACY_KEY) return 'nothing';
  const raw = await store.get(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY);
  if (raw === null) return 'nothing';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not ours to repair: the reader flags an unparseable value on every read.
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
