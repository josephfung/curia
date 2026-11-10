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
 * Parse the stored `{ "<mailbox>": "<level>" }` JSON. Anything missing or invalid
 * falls back to on_request: it never widens autonomy beyond the default, and keeps
 * principal-directed sends working. `malformed` is true for a stored value that is not
 * that shape, or names an unknown level for the mailbox (final review M2): a mistyped `off`
 * would otherwise become on_request with no trace. So is an object with keys but no `default`
 * entry (`{"Default":"off"}`, #2474 PR 2): a mistyped mailbox name is as silent as a mistyped
 * level. Unset, `{}`, or no entry for another mailbox while `default` is set, is not.
 */
export function readSendLevelValue(raw: string | null, mailbox: string = DEFAULT_MAILBOX): { level: SendLevel; malformed: boolean } {
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
  if (!Object.prototype.hasOwnProperty.call(parsed, mailbox)) {
    return fallback(Object.keys(parsed).length > 0 && !Object.prototype.hasOwnProperty.call(parsed, DEFAULT_MAILBOX));
  }
  const value = (parsed as Record<string, unknown>)[mailbox];
  return isSendLevel(value) ? { level: value, malformed: false } : fallback(true);
}

/** readSendLevelValue's level alone. */
export function parseSendLevel(raw: string | null, mailbox: string = DEFAULT_MAILBOX): SendLevel {
  return readSendLevelValue(raw, mailbox).level;
}

export type SendLevelReader = (mailbox: string) => Promise<SendLevel>;

export function createSendLevelReader(deps: {
  get(ns: string, key: string): Promise<string | null>;
  logger: Logger;
}): SendLevelReader {
  return async (mailbox) => {
    try {
      const { level, malformed } = readSendLevelValue(await deps.get(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY), mailbox);
      // Never the stored value: only that it could not be read as a level.
      if (malformed) deps.logger.warn({ mailbox }, 'ceo_inbox/sending is malformed, names an unknown level, or has no default entry; using on_request');
      return level;
    } catch (err) {
      // Fall back to on_request: never widens autonomy, keeps principal-directed sends working.
      deps.logger.warn({ err, mailbox }, 'Could not read ceo_inbox sending level; using on_request');
      return DEFAULT_SEND_LEVEL;
    }
  };
}
