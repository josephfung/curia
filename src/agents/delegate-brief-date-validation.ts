// delegate-brief-date-validation.ts — structural handoff from date-resolve to delegate (#1612).
//
// The DATE_RESOLVE_GUARDRAIL induces date-resolve tool calls, but the model can still
// pass a wrong calendar date into the specialist brief. This module rejects calendar
// delegations whose brief contradicts date-resolve results from the same turn.

import { DateTime } from 'luxon';
import type { ToolResult } from '../skills/types.js';

/** One resolved date produced by date-resolve earlier in the same agent turn. */
export interface TurnDateResolveResult {
  isoDate: string;
  formatted?: string;
}

export interface ValidateDelegateBriefDatesInput {
  agent: string;
  task: string;
  priorDateResolves: readonly TurnDateResolveResult[];
}

export type ValidateDelegateBriefDatesResult =
  | { ok: true }
  | { ok: false; error: string };

const CALENDAR_AGENT_PATTERN = /calendar/i;

const WEEKDAY =
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday';

/**
 * Genuine relative / day-of-week phrasing that requires a resolved date.
 * Deliberately excludes bare "next meeting" / "this call" / "schedule" —
 * those are not calendar dates to resolve.
 */
const RELATIVE_DATE_IN_BRIEF = new RegExp(
  String.raw`\b(tomorrow|today|${WEEKDAY}|next\s+(?:${WEEKDAY})|this\s+(?:${WEEKDAY}))\b`,
  'i',
);

/** ISO date or month+day natural forms that look like a stated calendar date. */
const DATE_LIKE_IN_BRIEF =
  /\b\d{4}-\d{2}-\d{2}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i;

const YEAR_IN_BRIEF = /\b(?:19|20)\d{2}\b/;

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

  // Full-date candidates (always safe — year pins the match).
  const candidates = new Set<string>();
  if (resolved.formatted) candidates.add(resolved.formatted);
  candidates.add(`${month} ${day}, ${year}`);
  candidates.add(`${month} ${day} ${year}`);
  candidates.add(`${monthShort} ${day}, ${year}`);
  candidates.add(`${day} ${month} ${year}`);
  candidates.add(`${month} ${ordinalDay}, ${year}`);
  candidates.add(`${month} ${ordinalDay} ${year}`);

  // Yearless month/day only when the brief does not already spell out a year —
  // otherwise "July 31, 2027" would falsely match a 2026-07-31 resolve.
  if (!YEAR_IN_BRIEF.test(brief)) {
    candidates.add(`${month} ${day}`);
    candidates.add(`${month} ${ordinalDay}`);
    candidates.add(`${monthShort} ${day}`);
  }

  const briefLower = brief.toLowerCase();
  for (const candidate of candidates) {
    if (briefLower.includes(candidate.toLowerCase())) return true;
  }
  return false;
}

export function validateDelegateBriefDates(
  input: ValidateDelegateBriefDatesInput,
): ValidateDelegateBriefDatesResult {
  const { agent, task, priorDateResolves } = input;

  if (!isCalendarDelegation(agent, task)) {
    return { ok: true };
  }

  const needsResolved = calendarBriefNeedsResolvedDate(task);
  const hasDateLike = briefHasDateLikeContent(task);

  // Relative/day-of-week asks must call date-resolve this turn.
  if (needsResolved && priorDateResolves.length === 0) {
    return {
      ok: false,
      error:
        'Calendar specialist requires date-resolve first — no resolved date was produced this turn',
    };
  }

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

  return { ok: true };
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
