// triage-cadence.ts — per-mailbox triage cadence (#2475, D4).
//
// A cadence is a frequency plus an optional window and weekday restriction, all read in the
// principal's timezone. The 15-minute code heartbeat asks isDue() per mailbox; nothing here
// calls a model or does I/O.
//
// Grammar:  (every <N>m | every <N>h | hourly | daily HH:MM)( HH:MM-HH:MM)?( weekdays)?
//   - minutes: a multiple of 15, at least 15 (the heartbeat's resolution).
//   - hours: 1 to 24.
//   - daily: HH:MM no later than 23:45 (the heartbeat's last check of a day).
//   - window: inclusive of both ends, in local time. A window that crosses midnight
//     (`22:00-02:00`) IS supported: it covers start..24:00 and 00:00..end. start == end is
//     refused (it would be a one-minute window, almost certainly a typo).
//   - weekdays: Monday to Friday by the LOCAL date. With a midnight-crossing window, the part
//     after midnight belongs to the window-START day: `22:00-02:00 weekdays` includes Saturday
//     01:00 (Friday night) and excludes Monday 01:00 (Sunday night).
import { DateTime } from 'luxon';
import type { Logger } from '../logger.js';

export interface Cadence {
  every: { minutes: number } | { dailyAt: string };
  window?: { start: string; end: string };
  weekdaysOnly?: boolean;
}

export const DEFAULT_CADENCE = 'hourly 06:00-23:00';
/** Triage batches per local day across all mailboxes (about 600 messages at batch size 5). */
export const TRIAGE_DAILY_CEILING = 120;
/** Messages per triage batch. */
export const TRIAGE_BATCH_SIZE = 5;
/** A due mailbox with more untriaged mail than this raises the backlog alarm. */
export const BACKLOG_ALARM_THRESHOLD = 100;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** The latest `daily HH:MM` the 15-minute heartbeat serves on the same local day. */
const LAST_DAILY_SLOT = '23:45';
const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

export function parseCadence(s: string): Cadence | null {
  const tokens = s.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  let every: Cadence['every'];
  let i = 1;
  const head = tokens[0]!;
  if (head === 'hourly') {
    every = { minutes: 60 };
  } else if (head === 'every') {
    const m = /^(\d+)([mh])$/.exec(tokens[1] ?? '');
    if (!m) return null;
    const n = Number(m[1]);
    if (m[2] === 'm') {
      if (n < 15 || n % 15 !== 0) return null;
      every = { minutes: n };
    } else {
      if (n < 1 || n > 24) return null;
      every = { minutes: n * 60 };
    }
    i = 2;
  } else if (head === 'daily') {
    const t = tokens[1] ?? '';
    if (!HHMM.test(t)) return null;
    // The heartbeat's last check of a local day is at 23:45, so a later daily time would first be
    // seen on the next day, and a mailbox never drained would never reach it. Refused.
    if (t > LAST_DAILY_SLOT) return null;
    every = { dailyAt: t };
    i = 2;
  } else {
    return null;
  }

  const cadence: Cadence = { every };
  const w = WINDOW.exec(tokens[i] ?? '');
  if (w) {
    const start = `${w[1]}:${w[2]}`;
    const end = `${w[3]}:${w[4]}`;
    if (start === end) return null;
    cadence.window = { start, end };
    i += 1;
  }
  if (tokens[i] === 'weekdays') {
    cadence.weekdaysOnly = true;
    i += 1;
  }
  return i === tokens.length ? cadence : null;
}

// An invalid stored cadence is logged once per (mailbox, value), not on every 15-minute tick.
const warned = new Set<string>();

/**
 * Resolve each live mailbox's cadence from the stored `ceo_inbox/triage` value (a JSON object
 * `{ "<mailbox>": "<cadence>" }`). Missing, unknown or invalid entries, and an unparseable whole
 * value, fall back to DEFAULT_CADENCE. Entries for mailboxes not in `mailboxIds` are ignored.
 */
export function readTriageCadences(
  raw: string | null,
  mailboxIds: string[],
  logger?: Pick<Logger, 'warn'>,
): Record<string, Cadence> {
  const fallback = parseCadence(DEFAULT_CADENCE)!;
  const warnOnce = (key: string, obj: Record<string, unknown>, msg: string): void => {
    // Remember the key only once a logger has actually emitted it.
    if (!logger || warned.has(key)) return;
    warned.add(key);
    logger.warn(obj, msg);
  };

  let stored: Record<string, unknown> = {};
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        stored = parsed as Record<string, unknown>;
      } else {
        warnOnce(`whole:${raw}`, {}, 'ceo_inbox/triage is not a JSON object; using the default cadence for every mailbox');
      }
    } catch (err) {
      warnOnce(`whole:${raw}`, { errName: err instanceof Error ? err.name : typeof err }, 'ceo_inbox/triage is not valid JSON; using the default cadence for every mailbox');
    }
  }

  const out: Record<string, Cadence> = {};
  for (const id of mailboxIds) {
    const value = Object.prototype.hasOwnProperty.call(stored, id) ? stored[id] : undefined;
    if (value === undefined) {
      out[id] = fallback;
      continue;
    }
    const parsed = typeof value === 'string' ? parseCadence(value) : null;
    if (parsed === null) {
      warnOnce(`${id}:${String(value)}`, { mailbox: id, cadence: String(value) }, 'invalid triage cadence; using the default');
    }
    out[id] = parsed ?? fallback;
  }
  return out;
}

function minutesOfDay(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** Heartbeat period; a drain is stamped up to this far from the tick that follows it. */
const HEARTBEAT_MS = 15 * 60_000;
/**
 * R50: tolerance for "interval elapsed". A drain is marked a few seconds after the tick that
 * started it, so a strict `>= every` would slip a whole tick (hourly drained 06:00:05 is not due
 * at 07:00:00). We accept `every - 7m30s`, but never below MIN_INTERVAL_MS (10 minutes, above
 * half a heartbeat), so `every 15m` is not due 8 minutes after a drain yet is due at the next tick.
 */
const TOLERANCE_MS = HEARTBEAT_MS / 2;
const MIN_INTERVAL_MS = 10 * 60_000;

/**
 * Whether `now` is inside the cadence's window and weekday restriction (local time, R51). A
 * cadence with neither is always inside. A draining mailbox bypasses the interval but not this
 * (R53). An invalid timezone throws.
 */
export function inWindow(c: Cadence, now: Date, tz: string): boolean {
  const local = DateTime.fromJSDate(now, { zone: tz });
  if (!local.isValid) {
    throw new Error(`inWindow: invalid timezone "${tz}" (${local.invalidReason ?? 'unknown reason'})`);
  }
  // The local day the cadence "belongs to" for the weekday check (R51).
  let dayForWeekday = local;
  if (c.window) {
    const t = local.hour * 60 + local.minute;
    const start = minutesOfDay(c.window.start);
    const end = minutesOfDay(c.window.end);
    const crosses = start > end;
    const inside = crosses ? t >= start || t <= end : t >= start && t <= end;
    if (!inside) return false;
    if (crosses && t <= end) dayForWeekday = local.minus({ days: 1 });
  }
  return !(c.weekdaysOnly && dayForWeekday.weekday > 5);
}

/**
 * Whether a mailbox is due: inside its window (and on a weekday if required), and either
 * the interval has elapsed since `lastDrainedAt` (within TOLERANCE_MS, see above) or, for
 * `daily HH:MM`, the last drain was before the most recent HH:MM (local): today's once `now` is at
 * or after it, else yesterday's, so a slot after the day's last heartbeat is served after midnight. A null lastDrainedAt, or one later than `now` (corrupt; it must not starve the
 * mailbox), counts as never drained. Elapsed time is real time; the window, weekday and daily
 * time are local wall-clock (the daily slot is built from the local calendar date, so a repeated
 * fall-back hour fires once and a skipped spring-forward time fires once, shifted). An invalid
 * timezone throws.
 */
export function isDue(c: Cadence, lastDrainedAt: Date | null, now: Date, tz: string): boolean {
  const local = DateTime.fromJSDate(now, { zone: tz });
  if (!local.isValid) {
    throw new Error(`isDue: invalid timezone "${tz}" (${local.invalidReason ?? 'unknown reason'})`);
  }
  if (lastDrainedAt !== null && lastDrainedAt.getTime() > now.getTime()) lastDrainedAt = null;

  if (!inWindow(c, now, tz)) return false;

  if ('dailyAt' in c.every) {
    const hour = Number(c.every.dailyAt.slice(0, 2));
    const minute = Number(c.every.dailyAt.slice(3, 5));
    const slotOn = (d: DateTime): number =>
      DateTime.fromObject({ year: d.year, month: d.month, day: d.day, hour, minute }, { zone: tz }).toMillis();
    const today = slotOn(local);
    if (now.getTime() >= today) return lastDrainedAt === null || lastDrainedAt.getTime() < today;
    // Before today's slot, yesterday's may still be unserved (Curia was down at the slot), so it
    // is served once after midnight. A mailbox never drained waits for today's slot.
    return lastDrainedAt !== null && lastDrainedAt.getTime() < slotOn(local.minus({ days: 1 }));
  }

  if (lastDrainedAt === null) return true;
  const everyMs = c.every.minutes * 60_000;
  const threshold = Math.max(everyMs - TOLERANCE_MS, MIN_INTERVAL_MS);
  return now.getTime() - lastDrainedAt.getTime() >= threshold;
}

/** The config-store key that holds the per-mailbox cadences, in namespace `ceo_inbox`. */
export const TRIAGE_CADENCE_KEY = 'triage';

/**
 * Validate a `ceo_inbox/triage` write (R65): a JSON object keyed by live mailbox ids whose values
 * all parse as cadences. A bad write would otherwise be stored, ignored by the reader with a
 * warning, and confirmed to the principal as if it had taken effect. Nothing is echoed back.
 */
export function checkTriageCadenceWrite(
  raw: string,
  live: ReadonlyArray<{ id: string; label: string }>,
): { ok: true } | { ok: false; error: string } {
  if (live.length === 0) {
    return { ok: false, error: 'No principal mailbox is connected yet, so there is no triage cadence to set. Nothing was stored.' };
  }
  const shape = `Store a JSON object {"<mailbox id>":"<cadence>"}, cadence like "hourly 06:00-23:00", "every 30m 08:00-18:00 weekdays" or "daily 08:00". Mailboxes: ${live.map((m) => `${m.id} (${m.label})`).join(', ')}. Nothing was stored.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `ceo_inbox/triage must be JSON (${err instanceof Error ? err.name : 'parse error'}). ${shape}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `ceo_inbox/triage must be an object keyed by mailbox id. ${shape}` };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  const liveIds = new Set(live.map((m) => m.id));
  const unknown = entries.filter(([k]) => !liveIds.has(k)).map(([k]) => k);
  if (unknown.length > 0) return { ok: false, error: `Not a connected mailbox: ${unknown.join(', ')}. ${shape}` };
  const bad = entries.filter(([, v]) => typeof v !== 'string' || parseCadence(v) === null).map(([k]) => k);
  if (bad.length > 0) return { ok: false, error: `Not a valid cadence for: ${bad.join(', ')}. ${shape}` };
  return { ok: true };
}
