// tests/smoke/date-placeholders.ts — relative dates in smoke stub fixtures (#1956).
//
// A case like "How does my Wednesday look?" needs calendar events on the coming
// Wednesday whenever the suite runs, so fixtures name dates relative to today, in the
// principal's timezone:
//
//   {{date:today+1}}                → 2026-10-03
//   {{time:next-wednesday 09:30}}   → 2026-10-07T09:30:00.000-04:00  (what calendar tools return)
//   {{weekday:today+3}}             → Monday
//
// A day is `today`, `today+N`, `today-N`, or `next-<weekday>` — the first such weekday
// strictly after today (so on a Wednesday, next-wednesday is a week out).
import { DateTime } from 'luxon';

const PLACEHOLDER = /\{\{\s*(date|time|weekday):([^}]+?)\s*\}\}/g;
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function resolveDay(spec: string, today: DateTime): DateTime {
  const s = spec.trim().toLowerCase();
  const relative = /^today(?:([+-])(\d+))?$/.exec(s);
  if (relative) {
    const n = relative[2] ? Number(relative[2]) * (relative[1] === '-' ? -1 : 1) : 0;
    return today.plus({ days: n });
  }
  const next = /^next-([a-z]+)$/.exec(s);
  if (next && WEEKDAYS.includes(next[1]!)) {
    const target = WEEKDAYS.indexOf(next[1]!) + 1; // luxon: Monday = 1
    const ahead = ((target - today.weekday + 7) % 7) || 7;
    return today.plus({ days: ahead });
  }
  throw new Error(`unknown day '${spec}' — use today, today+N, today-N or next-<weekday>`);
}

function resolveOne(kind: string, arg: string, today: DateTime): string {
  if (kind === 'date') return resolveDay(arg, today).toFormat('yyyy-MM-dd');
  if (kind === 'weekday') return resolveDay(arg, today).toFormat('cccc');
  // time: "<day> HH:mm"
  const m = /^(.+?)\s+(\d{1,2}):(\d{2})$/.exec(arg.trim());
  if (!m) throw new Error(`time placeholder '${arg}' must be '<day> HH:mm'`);
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) throw new Error(`time placeholder '${arg}' has an invalid time`);
  return resolveDay(m[1]!, today).set({ hour, minute, second: 0, millisecond: 0 }).toISO()!;
}

/**
 * Replace every date placeholder in `value` (strings at any depth). `now` and
 * `timezone` fix "today"; throws on a malformed placeholder.
 */
export function resolveDatePlaceholders<T>(value: T, timezone: string, now: Date = new Date()): T {
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  if (!today.isValid) throw new Error(`invalid timezone '${timezone}'`);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(PLACEHOLDER, (_, kind: string, arg: string) => resolveOne(kind, arg, today));
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner)]));
    }
    return v;
  };
  return walk(value) as T;
}
