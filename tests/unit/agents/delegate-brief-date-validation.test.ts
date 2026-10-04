import { describe, it, expect } from 'vitest';
import {
  briefContainsResolvedDate,
  briefHasDateLikeContent,
  calendarBriefNeedsResolvedDate,
  extractDateResolveResult,
  isCalendarDelegation,
  TurnDateResolveTracker,
  validateDelegateBriefDates,
} from '../../../src/agents/delegate-brief-date-validation.js';
import { RELATIVE_DAY_OFFSETS } from '../../../src/time/relative-days.js';

describe('isCalendarDelegation', () => {
  it('detects calendar agent name', () => {
    expect(isCalendarDelegation('calendar', 'list events')).toBe(true);
  });

  it('detects calendar mentioned in the brief', () => {
    expect(isCalendarDelegation('research-analyst', 'check my calendar tomorrow')).toBe(true);
  });

  it('returns false for non-calendar work', () => {
    expect(isCalendarDelegation('contacts', 'who is Jordan?')).toBe(false);
  });
});

describe('calendarBriefNeedsResolvedDate', () => {
  it('requires a date for relative phrasing', () => {
    expect(calendarBriefNeedsResolvedDate("What's on my calendar next Tuesday?")).toBe(true);
  });

  it('requires a date for bare weekdays', () => {
    expect(calendarBriefNeedsResolvedDate("What's on my calendar Friday?")).toBe(true);
  });

  it('requires a date for "yesterday"', () => {
    expect(calendarBriefNeedsResolvedDate('What was on my calendar yesterday?')).toBe(true);
  });

  // The brief check and date-resolve share one word list, so every word that makes a
  // brief need a resolved date is a word date-resolve can resolve (#1986).
  it('requires a date for every day word date-resolve resolves directly', () => {
    expect(RELATIVE_DAY_OFFSETS.size).toBeGreaterThan(0);
    for (const word of RELATIVE_DAY_OFFSETS.keys()) {
      expect(calendarBriefNeedsResolvedDate(`Check my calendar ${word}.`), word).toBe(true);
    }
  });

  it('does not require a date for move-without-day requests', () => {
    expect(calendarBriefNeedsResolvedDate('Move my three PM to four thirty.')).toBe(false);
  });

  it('does not treat "next meeting" / "this call" / bare schedule as relative dates', () => {
    expect(calendarBriefNeedsResolvedDate('Reschedule my next meeting.')).toBe(false);
    expect(calendarBriefNeedsResolvedDate('Join this call at 3.')).toBe(false);
    expect(calendarBriefNeedsResolvedDate('Schedule the meeting.')).toBe(false);
  });
});

describe('briefHasDateLikeContent', () => {
  it('detects ISO and natural month-day forms', () => {
    expect(briefHasDateLikeContent('Check 2026-07-31.')).toBe(true);
    expect(briefHasDateLikeContent('Book July 31 at 2pm.')).toBe(true);
    expect(briefHasDateLikeContent('Book July 31st, 2026.')).toBe(true);
  });

  it('does not treat time-only move briefs as date-like', () => {
    expect(briefHasDateLikeContent('Move my three PM to four thirty.')).toBe(false);
  });
});

describe('briefContainsResolvedDate', () => {
  const resolved = { isoDate: '2026-07-31', formatted: 'Friday, July 31, 2026' };

  it('matches ISO dates', () => {
    expect(briefContainsResolvedDate('Check 2026-07-31 for conflicts.', resolved)).toBe(true);
  });

  it('matches formatted natural dates', () => {
    expect(briefContainsResolvedDate('Schedule on Friday, July 31, 2026 at 2pm.', resolved)).toBe(
      true,
    );
  });

  it('matches month-day without weekday when brief has no year', () => {
    expect(briefContainsResolvedDate('Book July 31 at 2pm.', resolved)).toBe(true);
  });

  it('matches ordinal-suffixed dates', () => {
    expect(briefContainsResolvedDate('Book July 31st at 2pm.', resolved)).toBe(true);
    expect(briefContainsResolvedDate('Book July 31st, 2026 at 2pm.', resolved)).toBe(true);
  });

  it('rejects a contradicting date', () => {
    expect(briefContainsResolvedDate('Schedule on August 1, 2026 at 2pm.', resolved)).toBe(false);
  });

  it('rejects correct month-day with the wrong year', () => {
    expect(briefContainsResolvedDate('Schedule on July 31, 2027 at 2pm.', resolved)).toBe(false);
    expect(briefContainsResolvedDate('Schedule on July 31 2027 at 2pm.', resolved)).toBe(false);
    expect(briefContainsResolvedDate('Schedule on July 31st, 2027 at 2pm.', resolved)).toBe(false);
    expect(briefContainsResolvedDate('Schedule on July 31 of 2027 at 2pm.', resolved)).toBe(false);
    expect(briefContainsResolvedDate('Schedule on July 31 in 2027 at 2pm.', resolved)).toBe(false);
    expect(briefContainsResolvedDate('Schedule on July 31, 3026.', resolved)).toBe(false);
  });

  it("does not let a later date's year suppress the resolved month and day", () => {
    expect(
      briefContainsResolvedDate('Monday Sep 28 through Sunday Oct 4, 2027', {
        isoDate: '2026-09-28',
      }),
    ).toBe(true);
  });

  it('accepts a yearless start date when the year sits on a later date', () => {
    expect(
      briefContainsResolvedDate('Monday Sep 28 through Sunday Oct 4, 2026', {
        isoDate: '2026-09-28',
      }),
    ).toBe(true);
  });

  it('accepts the weekly range briefs that production rejected', () => {
    const cases = [
      ['Monday Sep 28 through Sunday Oct 4, 2026', '2026-09-28'],
      ['week of Monday September 21 through Sunday September 27, 2026', '2026-09-21'],
      ['Monday September 7 through Sunday September 13, 2026', '2026-09-07'],
      ['week of August 10\u201316, 2026', '2026-08-10'],
      ['week of August 3-9, 2026 (Monday through Sunday)', '2026-08-03'],
    ] as const;

    for (const [brief, isoDate] of cases) {
      expect(briefContainsResolvedDate(brief, { isoDate })).toBe(true);
    }
  });

  it('rejects a same-month span tied to a different year', () => {
    expect(
      briefContainsResolvedDate('week of August 10\u201316, 2027', { isoDate: '2026-08-10' }),
    ).toBe(false);
    expect(
      briefContainsResolvedDate('week of August 3-9, 2027', { isoDate: '2026-08-03' }),
    ).toBe(false);
    expect(
      briefContainsResolvedDate('week of August 10 to 16, 2027', { isoDate: '2026-08-10' }),
    ).toBe(false);
  });

  it('rejects a range that cites a different day', () => {
    expect(
      briefContainsResolvedDate('Monday Oct 5 through Sunday Oct 11, 2026', {
        isoDate: '2026-09-28',
      }),
    ).toBe(false);
  });

  it('does not treat a longer day number as the resolved day', () => {
    expect(
      briefContainsResolvedDate('Check September 13, 2026.', { isoDate: '2026-09-01' }),
    ).toBe(false);
    expect(
      briefContainsResolvedDate('Check September 13, 2026.', { isoDate: '2026-09-13' }),
    ).toBe(true);
  });

  it('matches short-month comma-less and ordinal forms', () => {
    const sep28 = { isoDate: '2026-09-28' };
    expect(briefContainsResolvedDate('Week of Sep 28 2026.', sep28)).toBe(true);
    expect(briefContainsResolvedDate('Week of Sep 28th, 2026.', sep28)).toBe(true);
    expect(briefContainsResolvedDate('Week of Sep 28th 2026.', sep28)).toBe(true);
    expect(briefContainsResolvedDate('Sep 28th through Oct 4, 2026', sep28)).toBe(true);
  });
});

describe('validateDelegateBriefDates', () => {
  const friday = { isoDate: '2026-07-31', formatted: 'Friday, July 31, 2026' };

  it('accepts a brief that matches date-resolve output', () => {
    const result = validateDelegateBriefDates({
      agent: 'calendar',
      task: 'Schedule a catch-up on Friday, July 31, 2026 at 2pm.',
      priorDateResolves: [friday],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts weekly range briefs whose year is on the end date', () => {
    const cases = [
      ['Monday Sep 28 through Sunday Oct 4, 2026', '2026-09-28'],
      ['week of Monday September 21 through Sunday September 27, 2026', '2026-09-21'],
      ['Monday September 7 through Sunday September 13, 2026', '2026-09-07'],
      ['week of August 10\u201316, 2026', '2026-08-10'],
      ['week of August 3-9, 2026 (Monday through Sunday)', '2026-08-03'],
    ] as const;

    for (const [task, isoDate] of cases) {
      expect(
        validateDelegateBriefDates({
          agent: 'calendar',
          task,
          priorDateResolves: [{ isoDate }],
        }).ok,
      ).toBe(true);
    }
  });

  it('rejects a brief that contradicts date-resolve output', () => {
    const result = validateDelegateBriefDates({
      agent: 'calendar',
      task: 'Schedule a catch-up on August 1, 2026 at 2pm.',
      priorDateResolves: [friday],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.error).toMatch(/must include a date date-resolve produced/i);
  });

  it('rejects relative calendar asks that skip date-resolve', () => {
    const result = validateDelegateBriefDates({
      agent: 'calendar',
      task: "What's on my calendar next Tuesday?",
      priorDateResolves: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.error).toMatch(/requires date-resolve first/i);
  });

  it('allows non-calendar delegations without date-resolve', () => {
    const result = validateDelegateBriefDates({
      agent: 'contacts',
      task: 'Look up Jordan Lee.',
      priorDateResolves: [],
    });
    expect(result.ok).toBe(true);
  });

  it('allows calendar move requests without relative dates', () => {
    const result = validateDelegateBriefDates({
      agent: 'calendar',
      task: 'Move my three PM to four thirty.',
      priorDateResolves: [],
    });
    expect(result.ok).toBe(true);
  });

  it('allows date-free calendar briefs even when an earlier date-resolve ran', () => {
    const result = validateDelegateBriefDates({
      agent: 'calendar',
      task: 'Move my three PM to four thirty.',
      priorDateResolves: [friday],
    });
    expect(result.ok).toBe(true);
  });

  it('does not over-trigger on "next meeting" / bare schedule without date-resolve', () => {
    expect(
      validateDelegateBriefDates({
        agent: 'calendar',
        task: 'Reschedule my next meeting.',
        priorDateResolves: [],
      }).ok,
    ).toBe(true);
    expect(
      validateDelegateBriefDates({
        agent: 'calendar',
        task: 'Schedule the meeting.',
        priorDateResolves: [],
      }).ok,
    ).toBe(true);
  });
});

describe('extractDateResolveResult', () => {
  it('parses a flat date-resolve payload', () => {
    expect(
      extractDateResolveResult({
        date: '2026-07-28',
        formatted: 'Tuesday, July 28, 2026',
      }),
    ).toEqual({
      isoDate: '2026-07-28',
      formatted: 'Tuesday, July 28, 2026',
    });
  });

  it('parses nested ToolResult.data payloads', () => {
    expect(
      extractDateResolveResult({
        data: { date: '2026-07-28', formatted: 'Tuesday, July 28, 2026' },
      }),
    ).toEqual({
      isoDate: '2026-07-28',
      formatted: 'Tuesday, July 28, 2026',
    });
  });
});

describe('TurnDateResolveTracker', () => {
  it('accumulates successful date-resolve results across a turn', () => {
    const tracker = new TurnDateResolveTracker();
    tracker.recordFromToolResult({
      success: true,
      data: { date: '2026-07-28', formatted: 'Tuesday, July 28, 2026' },
    });
    tracker.recordFromToolResult({ success: false, error: 'bad input' });
    tracker.recordFromJsonContent(
      JSON.stringify({ date: '2026-07-31', formatted: 'Friday, July 31, 2026' }),
    );

    expect(tracker.snapshot()).toEqual([
      { isoDate: '2026-07-28', formatted: 'Tuesday, July 28, 2026' },
      { isoDate: '2026-07-31', formatted: 'Friday, July 31, 2026' },
    ]);
  });
});
