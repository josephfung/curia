// triage-cadence.ts — per-mailbox triage cadence (#2475, D4).
//
// A cadence is a frequency plus an optional window and weekday restriction, all read in the
// principal's timezone. The 15-minute code heartbeat asks isDue() per mailbox; nothing here
// calls a model or does I/O.
//
// Grammar:  (every <N>m | every <N>h | hourly | daily HH:MM)( HH:MM-HH:MM)?( weekdays)?
//   - minutes: a multiple of 15, at least 15 (the heartbeat's resolution).
//   - hours: 1 to 24.
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
 * `daily HH:MM`, `now` is at or after today's HH:MM (local) and the last drain was before that
 * moment. A null lastDrainedAt, or one later than `now` (corrupt; it must not starve the
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
    const slot = DateTime.fromObject(
      {
        year: local.year,
        month: local.month,
        day: local.day,
        hour: Number(c.every.dailyAt.slice(0, 2)),
        minute: Number(c.every.dailyAt.slice(3, 5)),
      },
      { zone: tz },
    );
    if (now.getTime() < slot.toMillis()) return false;
    return lastDrainedAt === null || lastDrainedAt.getTime() < slot.toMillis();
  }

  if (lastDrainedAt === null) return true;
  const everyMs = c.every.minutes * 60_000;
  const threshold = Math.max(everyMs - TOLERANCE_MS, MIN_INTERVAL_MS);
  return now.getTime() - lastDrainedAt.getTime() >= threshold;
}
