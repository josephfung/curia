import type { Logger } from '../../logger.js';

/**
 * How freely Curia may send from the principal's mailbox (#2474).
 * off: never; on_request: only when the principal asked; routine/all: reserved
 * for autonomous sends (refused in PR 1).
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
 * principal-directed sends working.
 */
export function parseSendLevel(raw: string | null, mailbox: string = DEFAULT_MAILBOX): SendLevel {
  if (raw === null) return DEFAULT_SEND_LEVEL;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable setting: fall back to the default level (see above); not an error path to surface.
    return DEFAULT_SEND_LEVEL;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_SEND_LEVEL;
  const value = (parsed as Record<string, unknown>)[mailbox];
  return isSendLevel(value) ? value : DEFAULT_SEND_LEVEL;
}

export type SendLevelReader = (mailbox: string) => Promise<SendLevel>;

export function createSendLevelReader(deps: {
  get(ns: string, key: string): Promise<string | null>;
  logger: Logger;
}): SendLevelReader {
  return async (mailbox) => {
    try {
      return parseSendLevel(await deps.get(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY), mailbox);
    } catch (err) {
      // Fall back to on_request: never widens autonomy, keeps principal-directed sends working.
      deps.logger.warn({ err, mailbox }, 'Could not read ceo_inbox sending level; using on_request');
      return DEFAULT_SEND_LEVEL;
    }
  };
}
