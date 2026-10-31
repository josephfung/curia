// delegate-brief-date-validation.ts — structural handoff from date-resolve to delegate (#1612).
//
// The DATE_RESOLVE_GUARDRAIL induces date-resolve tool calls, but the model can still
// pass a wrong calendar date into the specialist brief. This module rejects calendar
// delegations whose brief contradicts date-resolve results from the same turn.

import { DateTime } from 'luxon';
import type { ToolResult } from '../skills/types.js';
import { escapeRegExp } from '../util/escape-regexp.js';
import { RELATIVE_DAY_OFFSETS } from '../time/relative-days.js';

/** One resolved date produced by date-resolve earlier in the same agent turn. */
export interface TurnDateResolveResult {
  isoDate: string;
  formatted?: string;
}

export interface ValidateDelegateBriefDatesInput {
  agent: string;
  task: string;
  priorDateResolves: readonly TurnDateResolveResult[];
  /**
   * The current time in the office timezone. When present, a brief with no
   * date-resolve this turn is checked against the clock instead of refused
   * outright (#2379); see {@link verifyBriefDatesAgainstClock}.
   */
  now?: DateTime;
}

/**
 * `task` is set when the brief was accepted with a note naming the dates its
 * day words resolve to; the caller sends that brief instead of the original.
 */
export type ValidateDelegateBriefDatesResult =
  | { ok: true; task?: string }
  | { ok: false; error: string };

const CALENDAR_AGENT_PATTERN = /calendar/i;

const WEEKDAY =
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday';

/**
 * Day words ("today", "tomorrow", "yesterday") from the list date-resolve shares, so
 * this check never requires a resolution for a word the tool can't resolve (#1986).
 */
const RELATIVE_DAY_WORDS = [...RELATIVE_DAY_OFFSETS.keys()].join('|');

/**
 * Genuine relative / day-of-week phrasing that requires a resolved date.
 * Deliberately excludes bare "next meeting" / "this call" / "schedule" —
 * those are not calendar dates to resolve. A bare weekday ("Friday") counts:
 * date-resolve rejects it as ambiguous and names "this Friday" / "next Friday".
 */
const RELATIVE_DATE_IN_BRIEF = new RegExp(
  String.raw`\b(${RELATIVE_DAY_WORDS}|${WEEKDAY}|next\s+(?:${WEEKDAY})|this\s+(?:${WEEKDAY}))\b`,
  'i',
);

/** ISO date or month+day natural forms that look like a stated calendar date. */
const DATE_LIKE_IN_BRIEF =
  /\b\d{4}-\d{2}-\d{2}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i;

const DAY_ORDINAL = String.raw`(?:st|nd|rd|th)`;

/**
 * A same-month span whose year sits on the end day: "10–16", "3-9",
 * "10 to 16", "10 through 16". A later separate date ("through Sunday Oct 4")
 * does not match — that year belongs to the other date.
 */
const SAME_MONTH_SPAN = String.raw`\s*(?:[\u2013\u2014-]|\b(?:to|through)\b)\s*\d{1,2}${DAY_ORDINAL}?\b`;

/** Comma, "of"/"in", or whitespace immediately before a four-digit year. */
const YEAR_SEPARATOR = String.raw`,\s*(?:(?:of|in)\s+)?|\s+(?:of|in)\s+|\s+`;

const YEAR_ON_THIS_DATE = new RegExp(
  `^(?:${SAME_MONTH_SPAN})?(?:${YEAR_SEPARATOR})(\\d{4})\\b`,
  'i',
);

export function isCalendarDelegation(agent: string, task: string): boolean {
  const agentLower = agent.toLowerCase();
  const taskLower = task.toLowerCase();
  return CALENDAR_AGENT_PATTERN.test(agentLower) || taskLower.includes('calendar');
}

/** True when the brief uses relative/day-of-week language that needs date-resolve. */
export function calendarBriefNeedsResolvedDate(task: string): boolean {
  return RELATIVE_DATE_IN_BRIEF.test(task);
}

/** True when the brief states a concrete calendar date (ISO or month+day). */
export function briefHasDateLikeContent(task: string): boolean {
  return DATE_LIKE_IN_BRIEF.test(task);
}

/** Parse a successful date-resolve tool payload into a turn record. */
export function extractDateResolveResult(data: unknown): TurnDateResolveResult | null {
  let record: Record<string, unknown> | null = null;
  if (typeof data === 'object' && data !== null) {
    record = data as Record<string, unknown>;
    if (typeof record.date !== 'string' && typeof record.data === 'object' && record.data !== null) {
      record = record.data as Record<string, unknown>;
    }
  }
  if (!record) return null;

  const isoDate = typeof record.date === 'string' ? record.date : null;
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;

  return {
    isoDate,
    formatted: typeof record.formatted === 'string' ? record.formatted : undefined,
  };
}

function dayWithOrdinal(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * True when some "<month> <day>" occurrence is this resolved date.
 * A year counts against the occurrence only when it is attached to it
 * ("July 31, 2027", "August 10–16, 2027"). A year on a different date in the
 * same brief ("Sep 28 through Oct 4, 2026") does not.
 */
function monthDayCitedWithoutConflictingYear(
  brief: string,
  monthNames: readonly string[],
  day: number,
  year: string,
): boolean {
  const names = [...new Set(monthNames)].sort((a, b) => b.length - a.length);
  if (names.length === 0) return false;

  const monthDay = new RegExp(
    String.raw`\b(?:${names.map(name => escapeRegExp(name)).join('|')})\s+${day}${DAY_ORDINAL}?\b`,
    'gi',
  );

  for (const match of brief.matchAll(monthDay)) {
    const text = match[0];
    if (!text) continue;
    const after = brief.slice(match.index + text.length);
    const attachedYear = YEAR_ON_THIS_DATE.exec(after)?.[1];
    if (attachedYear === undefined || attachedYear === year) return true;
  }
  return false;
}

/** True when the brief mentions the ISO date or a natural form date-resolve produced. */
export function briefContainsResolvedDate(
  brief: string,
  resolved: TurnDateResolveResult,
): boolean {
  if (brief.includes(resolved.isoDate)) return true;

  const dt = DateTime.fromISO(resolved.isoDate);
  if (!dt.isValid) return false;

  const month = dt.toFormat('MMMM');
  const monthShort = dt.toFormat('MMM');
  const day = dt.day;
  const year = dt.toFormat('yyyy');
  const ordinalDay = dayWithOrdinal(day);

  // Full-date candidates (year pins the match). Short-month forms mirror long-month
  // ones: comma, comma-less, and ordinal.
  const candidates = new Set<string>();
  if (resolved.formatted) candidates.add(resolved.formatted);
  candidates.add(`${month} ${day}, ${year}`);
  candidates.add(`${month} ${day} ${year}`);
  candidates.add(`${monthShort} ${day}, ${year}`);
  candidates.add(`${monthShort} ${day} ${year}`);
  candidates.add(`${day} ${month} ${year}`);
  candidates.add(`${month} ${ordinalDay}, ${year}`);
  candidates.add(`${month} ${ordinalDay} ${year}`);
  candidates.add(`${monthShort} ${ordinalDay}, ${year}`);
  candidates.add(`${monthShort} ${ordinalDay} ${year}`);

  const briefLower = brief.toLowerCase();
  for (const candidate of candidates) {
    if (briefLower.includes(candidate.toLowerCase())) return true;
  }

  return monthDayCitedWithoutConflictingYear(brief, [month, monthShort], day, year);
}

const MONTH_NAME =
  'january|february|march|april|may|june|july|august|september|october|november|december' +
  '|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';

/** "October 31, 2026", "Oct 19", "Nov 1st 2026", or "2026-10-31". Groups: month, day, year | iso. */
const CONCRETE_DATE = String.raw`(?:(${MONTH_NAME})\.?\s+(\d{1,2})${DAY_ORDINAL}?\b(?:,?\s+(\d{4})\b)?|(\d{4}-\d{2}-\d{2})\b)`;

/** A weekday written directly before a concrete date: "Saturday, October 31, 2026". */
const WEEKDAY_WITH_DATE = new RegExp(String.raw`\b(${WEEKDAY})\b,?\s+${CONCRETE_DATE}`, 'gi');
const ANY_WEEKDAY = new RegExp(String.raw`\b(?:${WEEKDAY})\b`, 'gi');
const QUALIFIED_WEEKDAY = new RegExp(String.raw`\b(?:next|this)\s+(?:${WEEKDAY})\b`, 'i');
const DAY_WORD = new RegExp(String.raw`\b(${RELATIVE_DAY_WORDS})\b`, 'gi');
const SHORT_WEEKDAY = 'mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun';
/**
 * A day word with the date it names written right after it: "today, Saturday,
 * October 31, 2026", "tomorrow's calendar (Thu Oct 22, 2026)", "yesterday (Oct 27)".
 */
const DAY_WORD_WITH_DATE = new RegExp(
  String.raw`\b(${RELATIVE_DAY_WORDS})(?:'s)?(?:\s+calendar)?\s*[,(]?\s*(?:(?:${WEEKDAY}|${SHORT_WEEKDAY})\.?,?\s+)?${CONCRETE_DATE}`,
  'gi',
);

/** The date a CONCRETE_DATE match names; a missing year is the one nearest `now`. */
function concreteDate(match: RegExpExecArray, offset: number, now: DateTime): DateTime | null {
  const [month, day, year, iso] = match.slice(offset, offset + 4);
  if (iso) {
    const dt = DateTime.fromISO(iso, { zone: now.zone });
    return dt.isValid ? dt : null;
  }
  const parse = (y: number): DateTime | null => {
    const dt = DateTime.fromFormat(`${month!.slice(0, 3)} ${day} ${y}`, 'LLL d yyyy', { zone: now.zone });
    return dt.isValid ? dt : null;
  };
  if (year) return parse(Number(year));
  const candidates = [now.year - 1, now.year, now.year + 1]
    .map(parse)
    .filter((dt): dt is DateTime => dt !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, dt) =>
    Math.abs(dt.diff(now).toMillis()) < Math.abs(best.diff(now).toMillis()) ? dt : best);
}

export type ClockVerification =
  | { status: 'verified'; resolved: TurnDateResolveResult[]; task: string }
  | { status: 'contradicted'; error: string }
  /** Phrasing the clock alone cannot settle ("next Monday", a weekday with no date). */
  | { status: 'unverifiable' };

/**
 * Check a calendar brief's day phrasing against the clock, so a brief that
 * already states its dates needs no date-resolve round (#2379). The model
 * nearly always writes "today, Saturday, October 31, 2026"; the gate used to
 * refuse that and cost a round (98 refusals in 30 days of prod, 82 of them
 * from scheduled jobs). What it still catches is what #1612 is for: a wrong
 * date. Day words resolve from `now`. A weekday must sit directly before a date
 * and be that date's weekday. "next/this <weekday>" and a weekday with no date
 * are left to date-resolve. Day words whose date the brief does not state get
 * a note appended, so the specialist reads an absolute date.
 */
export function verifyBriefDatesAgainstClock(task: string, now: DateTime): ClockVerification {
  if (QUALIFIED_WEEKDAY.test(task)) return { status: 'unverifiable' };

  const resolved: TurnDateResolveResult[] = [];
  const record = (dt: DateTime): void => {
    const isoDate = dt.toISODate();
    if (isoDate && !resolved.some(r => r.isoDate === isoDate)) {
      resolved.push({ isoDate, formatted: dt.toFormat('cccc, LLLL d, yyyy') });
    }
  };

  // Every weekday must be one written before a date, and must match it.
  const weekdayCount = [...task.matchAll(ANY_WEEKDAY)].length;
  let pairedCount = 0;
  for (const match of task.matchAll(WEEKDAY_WITH_DATE)) {
    const dt = concreteDate(match, 2, now);
    if (!dt) return { status: 'unverifiable' };
    const written = match[1]!;
    if (dt.toFormat('cccc').toLowerCase() !== written.toLowerCase()) {
      return {
        status: 'contradicted',
        error:
          `Brief says ${written} for ${dt.toFormat('LLLL d, yyyy')}, which is a ${dt.toFormat('cccc')}. ` +
          'Correct the date or the weekday (date-resolve can check it), then delegate again.',
      };
    }
    pairedCount += 1;
    record(dt);
  }
  if (pairedCount < weekdayCount) return { status: 'unverifiable' };

  // A day word written beside a date must name that date: "today, Saturday, October 24"
  // on the 31st is a wrong date, even though the 24th is a Saturday.
  for (const match of task.matchAll(DAY_WORD_WITH_DATE)) {
    const word = match[1]!.toLowerCase();
    const written = concreteDate(match, 2, now);
    if (!written) return { status: 'unverifiable' };
    const actual = now.startOf('day').plus({ days: RELATIVE_DAY_OFFSETS.get(word)! });
    if (written.toISODate() !== actual.toISODate()) {
      return {
        status: 'contradicted',
        error:
          `Brief says ${word} is ${written.toFormat('LLLL d, yyyy')}, but ${word} is ` +
          `${actual.toFormat('cccc, LLLL d, yyyy')}. Correct the date, then delegate again.`,
      };
    }
  }

  const notes: string[] = [];
  for (const match of task.matchAll(DAY_WORD)) {
    const word = match[1]!.toLowerCase();
    const dt = now.startOf('day').plus({ days: RELATIVE_DAY_OFFSETS.get(word)! });
    record(dt);
    const result = resolved.find(r => r.isoDate === dt.toISODate())!;
    if (!briefContainsResolvedDate(task, result) && !notes.some(n => n.startsWith(`${word} `))) {
      notes.push(`${word} is ${result.formatted}`);
    }
  }

  return {
    status: 'verified',
    resolved,
    task: notes.length > 0 ? `${task}\n\n(Dates: ${notes.join('; ')}.)` : task,
  };
}

export function validateDelegateBriefDates(
  input: ValidateDelegateBriefDatesInput,
): ValidateDelegateBriefDatesResult {
  const { agent, priorDateResolves: turnResolves, now } = input;
  let { task } = input;
  let priorDateResolves = turnResolves;
  let rewritten = false;

  if (!isCalendarDelegation(agent, task)) {
    return { ok: true };
  }

  const needsResolved = calendarBriefNeedsResolvedDate(task);

  // Relative/day-of-week asks need a resolved date this turn. A brief that states its dates
  // is checked against the clock instead of costing a date-resolve round (#2379). Otherwise
  // the error names the next step (#2227): with the bare refusal, a coordinator sometimes
  // gave up on the calendar and went on without reading it (scenario 25k: a booking-page
  // slot picked blind, 2 of 9 runs).
  if (needsResolved && priorDateResolves.length === 0) {
    const checked = now ? verifyBriefDatesAgainstClock(task, now) : { status: 'unverifiable' as const };
    if (checked.status === 'contradicted') return { ok: false, error: checked.error };
    if (checked.status === 'unverifiable') {
      return {
        ok: false,
        error:
          'Calendar specialist requires date-resolve first — no resolved date was produced this turn. ' +
          'Call date-resolve for the days the brief names ("next week", "Monday"), then delegate again ' +
          'with the resolved dates in the brief.',
      };
    }
    rewritten = checked.task !== task;
    task = checked.task;
    priorDateResolves = checked.resolved;
  }

  const hasDateLike = briefHasDateLikeContent(task);

  // When the brief states a date (relative ask, or concrete date-like text) and
  // date-resolve already ran, require the brief to cite one of those results.
  // Unrelated earlier date-resolve calls do NOT force date-free briefs (e.g.
  // "move my 3pm to 4:30") to include a resolved date.
  if (priorDateResolves.length > 0 && (needsResolved || hasDateLike)) {
    const matched = priorDateResolves.find(resolved => briefContainsResolvedDate(task, resolved));
    if (!matched) {
      const isoList = priorDateResolves.map(r => r.isoDate).join(', ');
      return {
        ok: false,
        error:
          `Brief must include a date date-resolve produced this turn (${isoList}); natural form OK (e.g. July 28, 2026)`,
      };
    }
  }

  return rewritten ? { ok: true, task } : { ok: true };
}

/** Tracks date-resolve outputs within one agent turn (text or voice). */
export class TurnDateResolveTracker {
  private readonly results: TurnDateResolveResult[] = [];

  snapshot(): readonly TurnDateResolveResult[] {
    return this.results;
  }

  recordFromToolResult(result: ToolResult): void {
    if (!result.success) return;
    const extracted = extractDateResolveResult(result.data);
    if (extracted) this.results.push(extracted);
  }

  /** Record from a voice bridge JSON tool_result string. */
  recordFromJsonContent(content: string, isError?: boolean): void {
    if (isError) return;
    try {
      const parsed: unknown = JSON.parse(content);
      const extracted = extractDateResolveResult(parsed);
      if (extracted) this.results.push(extracted);
    } catch {
      // Non-JSON tool results are not date-resolve payloads.
    }
  }
}
