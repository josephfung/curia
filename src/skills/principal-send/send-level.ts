import type { Logger } from '../../logger.js';

/**
 * How freely Curia may send from the principal's mailbox (#2474).
 * off: never; on_request: only when the principal asked; routine: also the
 * agent's own acknowledgement, thanks and logistics replies; all: also replies
 * making commitments the thread supports (limits enforced in the gateway).
 */
export type SendLevel = 'off' | 'on_request' | 'routine' | 'all';

export const SEND_SETTING_NAMESPACE = 'ceo_inbox';
export const SEND_SETTING_KEY = 'sending';
export const DEFAULT_MAILBOX = 'default';
export const DEFAULT_SEND_LEVEL: SendLevel = 'on_request';

const LEVELS: readonly SendLevel[] = ['off', 'on_request', 'routine', 'all'];

function isSendLevel(v: unknown): v is SendLevel {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

/**
 * Parse the stored `{ "<mailbox id>": "<level>" }` JSON. Anything missing or invalid
 * falls back to on_request: it never widens autonomy beyond the default, and keeps
 * principal-directed sends working. `malformed` is true for a stored value that is not that
 * shape, or names an unknown level for this mailbox (final review M2): a mistyped `off` would
 * otherwise become on_request with no trace. A mailbox with no key of its own (a newly added
 * one, #2475) is not malformed: it reads on_request, never another mailbox's level.
 *
 * `legacyDefault` is for the default mailbox only: before boot renames the pre-#2475 `default`
 * key to the migrated id (migrateSendingKey), that key still carries the install's level, so a
 * missing own key reads it instead of silently dropping to on_request. An own key wins.
 */
export function readSendLevelValue(
  raw: string | null,
  mailbox: string = DEFAULT_MAILBOX,
  legacyDefault = false,
): { level: SendLevel; malformed: boolean } {
  const fallback = (malformed: boolean) => ({ level: DEFAULT_SEND_LEVEL, malformed });
  if (raw === null) return fallback(false);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable setting: the default level, flagged so the reader warns (see above).
    return fallback(true);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback(true);
  const has = (key: string) => Object.prototype.hasOwnProperty.call(parsed, key);
  const key = has(mailbox) ? mailbox : legacyDefault && has(DEFAULT_MAILBOX) ? DEFAULT_MAILBOX : null;
  if (key === null) return fallback(false);
  const value = (parsed as Record<string, unknown>)[key];
  return isSendLevel(value) ? { level: value, malformed: false } : fallback(true);
}

/** readSendLevelValue's level alone. */
export function parseSendLevel(raw: string | null, mailbox: string = DEFAULT_MAILBOX): SendLevel {
  return readSendLevelValue(raw, mailbox).level;
}

/** A stored object with keys, none of them `default` or a live mailbox id (a mistyped key, say). */
function namesNoKnownMailbox(raw: string, live: readonly string[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // unparseable is reported as malformed by the caller
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  return keys.length > 0 && !keys.some((k) => k === DEFAULT_MAILBOX || live.includes(k));
}

export type SendLevelReader = (mailbox: string) => Promise<SendLevel>;

export function createSendLevelReader(deps: {
  get(ns: string, key: string): Promise<string | null>;
  logger: Logger;
  /**
   * The live mailbox ids. A legacy `default` key applies only while exactly one is live (R41):
   * it was set for the install's one mailbox, so a second mailbox, or a changed default, never
   * inherits it. Also lets the reader warn about a stored object that names none of them.
   * Absent: no legacy fallback and no such warning.
   */
  liveMailboxIds?: () => Promise<readonly string[]>;
}): SendLevelReader {
  const warnedUnknown = new Set<string>();
  return async (mailbox) => {
    try {
      // A failed lookup reads as "not the only mailbox": the stricter, never-widening side.
      let live: readonly string[] | undefined;
      if (deps.liveMailboxIds) {
        try {
          live = await deps.liveMailboxIds();
        } catch (err) {
          deps.logger.warn({ err, mailbox }, 'Could not list the live mailboxes for the send level; not applying the legacy key');
        }
      }
      const legacyDefault = live !== undefined && live.length === 1 && live[0] === mailbox;
      const raw = await deps.get(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY);
      if (live !== undefined && raw !== null && !warnedUnknown.has(raw) && namesNoKnownMailbox(raw, live)) {
        // Once per process per value; never the stored value itself.
        warnedUnknown.add(raw);
        deps.logger.warn('ceo_inbox/sending has entries but none for a live mailbox or "default"; every mailbox uses on_request');
      }
      const { level, malformed } = readSendLevelValue(raw, mailbox, legacyDefault);
      // Never the stored value: only that it could not be read as a level.
      if (malformed) deps.logger.warn({ mailbox }, 'ceo_inbox/sending is malformed or names an unknown level; using on_request');
      return level;
    } catch (err) {
      // Fall back to on_request: never widens autonomy, keeps principal-directed sends working.
      deps.logger.warn({ err, mailbox }, 'Could not read ceo_inbox sending level; using on_request');
      return DEFAULT_SEND_LEVEL;
    }
  };
}
