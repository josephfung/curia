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

/** Relative / day-of-week phrasing that requires a resolved date in calendar briefs. */
const RELATIVE_DATE_IN_BRIEF =
  /\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+\w+|this\s+\w+|what'?s on|what is on|anything\s+(on|scheduled)|schedule\b)/i;

export function isCalendarDelegation(agent: string, task: string): boolean {
  const agentLower = agent.toLowerCase();
  const taskLower = task.toLowerCase();
  return CALENDAR_AGENT_PATTERN.test(agentLower) || taskLower.includes('calendar');
}

export function calendarBriefNeedsResolvedDate(
  task: string,
  priorDateResolves: readonly TurnDateResolveResult[],
): boolean {
  return RELATIVE_DATE_IN_BRIEF.test(task) || priorDateResolves.length > 0;
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

/** True when the brief mentions the ISO date or a natural form date-resolve produced. */
export function briefContainsResolvedDate(
  brief: string,
  resolved: TurnDateResolveResult,
): boolean {
  if (brief.includes(resolved.isoDate)) return true;

  const dt = DateTime.fromISO(resolved.isoDate);
  if (!dt.isValid) return false;

  const candidates = new Set<string>();
  if (resolved.formatted) candidates.add(resolved.formatted);
  candidates.add(dt.toFormat('MMMM d, yyyy'));
  candidates.add(dt.toFormat('MMMM d yyyy'));
  candidates.add(dt.toFormat('MMM d, yyyy'));
  candidates.add(dt.toFormat('d MMMM yyyy'));
  candidates.add(dt.toFormat('MMMM do, yyyy'));
  candidates.add(dt.toFormat('MMMM do'));
  candidates.add(dt.toFormat('MMMM d'));

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

  if (!calendarBriefNeedsResolvedDate(task, priorDateResolves)) {
    return { ok: true };
  }

  if (priorDateResolves.length === 0) {
    return {
      ok: false,
      error:
        'Calendar specialist requires date-resolve first — no resolved date was produced this turn',
    };
  }

  const matched = priorDateResolves.find(resolved => briefContainsResolvedDate(task, resolved));
  if (!matched) {
    const isoList = priorDateResolves.map(r => r.isoDate).join(', ');
    return {
      ok: false,
      error:
        `Brief must include a date date-resolve produced this turn (${isoList}); natural form OK (e.g. July 28, 2026)`,
    };
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
