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

/**
 * A live mailbox as the send level reads it. `triageStartAt` is null only on the row the flat
 * migration created (the console's add sets it) and on the deferred fallback: that is how the
 * install's one pre-#2475 mailbox is told apart from any added later (S-I1).
 */
export interface SendLevelMailbox {
  id: string;
  triageStartAt: Date | null;
}

/**
 * The mailbox the legacy `default` key applies to, or null (R41, S-I1): the migrated mailbox (or the
 * fallback), and only while it is the one live mailbox. The key was set for that mailbox, so a
 * mailbox added later, or a second live one, never inherits it.
 */
export function legacyDefaultMailbox(live: readonly SendLevelMailbox[]): string | null {
  return live.length === 1 && live[0]!.triageStartAt === null ? live[0]!.id : null;
}

/** The stored object's keys, or null when the value is not a JSON object. */
function storedKeys(raw: string, logger: Logger): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Unparseable is reported as malformed by the caller; noted here too, never the value.
    logger.debug({ errName: err instanceof Error ? err.name : typeof err }, 'ceo_inbox/sending is not valid JSON; no mailbox-key check');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return Object.keys(parsed);
}

/**
 * Keys that set no mailbox's level: not a live id, or a `default` that applies to none (SF5).
 * Mailbox ids are not secret; the levels are never logged.
 */
function ignoredKeys(keys: readonly string[], live: readonly SendLevelMailbox[]): string[] {
  const legacy = legacyDefaultMailbox(live);
  return keys.filter((k) => (k === DEFAULT_MAILBOX ? legacy === null : !live.some((m) => m.id === k)));
}

/**
 * Check a `ceo_inbox/sending` write before it is stored (SF5): a JSON object whose every key is a
 * live mailbox id (or `default` while it still applies) and every value a level. A key that names
 * no live mailbox would be silently ignored, so the agent would confirm a level with no effect.
 * The error names the live mailboxes so the agent can retry.
 */
export function checkSendLevelWrite(
  raw: string,
  live: ReadonlyArray<SendLevelMailbox & { label: string }>,
): { ok: true } | { ok: false; error: string } {
  // Nothing to key a level by (M3): say so rather than describe a shape no key can fill.
  if (live.length === 0) {
    return { ok: false, error: 'No principal mailbox is connected yet, so there is nothing to set a sending level for. Nothing was stored.' };
  }
  const mailboxes = live.map((m) => `${m.id} (${m.label})`).join(', ');
  const shape = `Store a JSON object {"<mailbox id>":"<level>"}, level ${LEVELS.join(' | ')}. Mailboxes: ${mailboxes}. Nothing was stored.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all: the agent is told the shape (no value is logged or echoed).
    return { ok: false, error: `ceo_inbox/sending must be JSON. ${shape}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `ceo_inbox/sending must be an object keyed by mailbox id. ${shape}` };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  const unknown = ignoredKeys(entries.map(([k]) => k), live);
  if (unknown.length > 0) {
    // The legacy key is named apart (M2): it was a mailbox once, so "not connected" would mislead.
    const legacy = unknown.includes(DEFAULT_MAILBOX) ? '"default" no longer applies; set a level per mailbox id. ' : '';
    const others = unknown.filter((k) => k !== DEFAULT_MAILBOX);
    const notConnected = others.length > 0 ? `Not a connected mailbox: ${others.join(', ')}. ` : '';
    return { ok: false, error: `${legacy}${notConnected}${shape}` };
  }
  const badLevel = entries.filter(([, v]) => !isSendLevel(v)).map(([k]) => k);
  if (badLevel.length > 0) {
    return { ok: false, error: `Not a level for ${badLevel.join(', ')}. ${shape}` };
  }
  return { ok: true };
}

export type SendLevelReader = (mailbox: string) => Promise<SendLevel>;

export function createSendLevelReader(deps: {
  get(ns: string, key: string): Promise<string | null>;
  logger: Logger;
  /**
   * The live mailboxes. A legacy `default` key applies only to the migrated mailbox while it is the
   * one live mailbox (legacyDefaultMailbox: R41, S-I1). Also lets the reader warn, once per key,
   * about a stored key that sets no mailbox's level (SF5). Absent: no legacy fallback, no warning.
   */
  liveMailboxes?: () => Promise<readonly SendLevelMailbox[]>;
}): SendLevelReader {
  const warned = new Set<string>();
  return async (mailbox) => {
    try {
      // A failed lookup reads as "not the only mailbox": the stricter, never-widening side.
      let live: readonly SendLevelMailbox[] | undefined;
      if (deps.liveMailboxes) {
        try {
          live = await deps.liveMailboxes();
        } catch (err) {
          deps.logger.warn({ errName: err instanceof Error ? err.name : typeof err, mailbox }, 'Could not list the live mailboxes for the send level; not applying the legacy key');
        }
      }
      const legacyDefault = live !== undefined && legacyDefaultMailbox(live) === mailbox;
      const raw = await deps.get(SEND_SETTING_NAMESPACE, SEND_SETTING_KEY);
      if (live !== undefined && raw !== null) {
        const keys = storedKeys(raw, deps.logger);
        // Once per process per key; the key (a mailbox id) only, never the stored level.
        for (const key of keys === null ? [] : ignoredKeys(keys, live)) {
          if (warned.has(key)) continue;
          warned.add(key);
          deps.logger.warn(
            { key, liveMailboxIds: live.map((m) => m.id) },
            key === DEFAULT_MAILBOX
              ? 'ceo_inbox/sending has a legacy "default" entry that applies to no live mailbox; it is ignored, set a level per mailbox'
              : 'ceo_inbox/sending has an entry for a mailbox that is not live; it is ignored',
          );
        }
      }
      const { level, malformed } = readSendLevelValue(raw, mailbox, legacyDefault);
      // Never the stored value: only that it could not be read as a level.
      if (malformed) deps.logger.warn({ mailbox }, 'ceo_inbox/sending is malformed or names an unknown level; using on_request');
      return level;
    } catch (err) {
      // Fall back to on_request: never widens autonomy, keeps principal-directed sends working.
      deps.logger.warn({ errName: err instanceof Error ? err.name : typeof err, mailbox }, 'Could not read ceo_inbox sending level; using on_request');
      return DEFAULT_SEND_LEVEL;
    }
  };
}
