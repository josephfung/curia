// skills/date-resolve/handler.test.ts
//
// Tests for the date-resolve skill. All tests are pure computation —
// no mocks, no external services.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DateResolveHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { DateTime, Settings } from 'luxon';
import pino from 'pino';

function makeCtx(input: Record<string, unknown>, timezone = 'America/Toronto'): SkillContext {
  return {
    input,
    timezone,
    log: pino({ level: 'silent' }),
  } as unknown as SkillContext;
}

const handler = new DateResolveHandler();

describe('DateResolveHandler', () => {
  // ── Input validation ─────────────────────────────────────────────────────

  it('returns error when neither date nor relative is provided', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/date.*relative/i);
  });

  it('returns error for unparseable date', async () => {
    const result = await handler.execute(makeCtx({ date: 'not-a-date' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/could not parse/i);
  });

  it('returns error for unrecognized relative expression', async () => {
    const result = await handler.execute(makeCtx({ relative: 'sometime next week maybe' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/could not resolve/i);
  });

  it('returns error for invalid expected_day name', async () => {
    const result = await handler.execute(makeCtx({ date: '2026-05-19', expected_day: 'Funday' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/unrecognized day/i);
  });

  // ── Date lookup (absolute date → day-of-week) ───────────────────────────

  it('resolves ISO date to correct day-of-week', async () => {
    const result = await handler.execute(makeCtx({ date: '2026-05-19' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        date: '2026-05-19',
        day_of_week: 'Tuesday',
        formatted: 'Tuesday, May 19, 2026',
      });
    }
  });

  it('resolves natural date format "May 19, 2026"', async () => {
    const result = await handler.execute(makeCtx({ date: 'May 19, 2026' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        date: '2026-05-19',
        day_of_week: 'Tuesday',
      });
    }
  });

  it('resolves natural date without comma "May 19 2026"', async () => {
    const result = await handler.execute(makeCtx({ date: 'May 19 2026' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ date: '2026-05-19', day_of_week: 'Tuesday' });
    }
  });

  it('resolves abbreviated month "May 7, 2026"', async () => {
    // May 7, 2026 is a Thursday (the date from the real incident)
    const result = await handler.execute(makeCtx({ date: 'May 7, 2026' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        date: '2026-05-07',
        day_of_week: 'Thursday',
        formatted: 'Thursday, May 7, 2026',
      });
    }
  });

  it('resolves US slash format "05/19/2026"', async () => {
    const result = await handler.execute(makeCtx({ date: '05/19/2026' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ date: '2026-05-19', day_of_week: 'Tuesday' });
    }
  });

  // ── Verification mode ────────────────────────────────────────────────────

  it('verifies correct date + day-of-week pairing', async () => {
    const result = await handler.execute(makeCtx({ date: '2026-05-19', expected_day: 'Tuesday' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        correct: true,
        expected_day: 'Tuesday',
        day_of_week: 'Tuesday',
      });
    }
  });

  it('catches incorrect date + day-of-week pairing', async () => {
    // This is the exact error from the May 7 incident: "Monday May 19"
    const result = await handler.execute(makeCtx({ date: '2026-05-19', expected_day: 'Monday' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        correct: false,
        expected_day: 'Monday',
        day_of_week: 'Tuesday',
      });
    }
  });

  it('handles case-insensitive expected_day', async () => {
    const result = await handler.execute(makeCtx({ date: '2026-05-19', expected_day: 'tuesday' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ correct: true, expected_day: 'Tuesday' });
    }
  });

  // ── Relative date resolution ─────────────────────────────────────────────

  describe('relative expressions (anchored to Thu May 7, 2026)', () => {
    // Compute the fixed timestamp once outside the mock to avoid infinite recursion
    // (Settings.now → DateTime.fromISO → Settings.now → …)
    const fixedMs = DateTime.fromISO('2026-05-07T12:00:00', { zone: 'America/Toronto' }).toMillis();

    beforeEach(() => {
      Settings.now = () => fixedMs;
    });

    afterEach(() => {
      Settings.now = () => Date.now();
    });

    it('"next Monday" → Monday May 11, 2026', async () => {
      const result = await handler.execute(makeCtx({ relative: 'next Monday' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({
          date: '2026-05-11',
          day_of_week: 'Monday',
          formatted: 'Monday, May 11, 2026',
        });
      }
    });

    it('"next Thursday" → Thursday May 14 (not today)', async () => {
      // "next Thursday" when today is Thursday should go to next week
      const result = await handler.execute(makeCtx({ relative: 'next Thursday' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ date: '2026-05-14', day_of_week: 'Thursday' });
      }
    });

    it('"this Monday" → Monday May 4 (earlier this week)', async () => {
      // May 7 is Thursday → Monday of this ISO week is May 4
      const result = await handler.execute(makeCtx({ relative: 'this Monday' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ date: '2026-05-04', day_of_week: 'Monday' });
      }
    });

    it('"this Friday" → Friday May 8 (tomorrow)', async () => {
      const result = await handler.execute(makeCtx({ relative: 'this Friday' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ date: '2026-05-08', day_of_week: 'Friday' });
      }
    });

    it('"Monday of the week of May 18" → Monday May 18', async () => {
      const result = await handler.execute(makeCtx({ relative: 'Monday of the week of May 18, 2026' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ date: '2026-05-18', day_of_week: 'Monday' });
      }
    });

    it('"Wednesday of the week of May 18" → Wednesday May 20', async () => {
      const result = await handler.execute(makeCtx({ relative: 'Wednesday of the week of May 18, 2026' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ date: '2026-05-20', day_of_week: 'Wednesday' });
      }
    });

    it('"Friday of the week of May 18" → Friday May 22', async () => {
      const result = await handler.execute(makeCtx({ relative: 'Friday of the week of May 18, 2026' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ date: '2026-05-22', day_of_week: 'Friday' });
      }
    });

    it('"Monday after May 15" → Monday May 18', async () => {
      const result = await handler.execute(makeCtx({ relative: 'Monday after May 15, 2026' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ date: '2026-05-18', day_of_week: 'Monday' });
      }
    });

    it('"Friday after May 15" → Friday May 22 (May 15 is a Friday, so skip to next)', async () => {
      const result = await handler.execute(makeCtx({ relative: 'Friday after May 15, 2026' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ date: '2026-05-22', day_of_week: 'Friday' });
      }
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it('handles month boundary (May 31 → June 1)', async () => {
    const result = await handler.execute(makeCtx({ date: '2026-05-31' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ date: '2026-05-31', day_of_week: 'Sunday' });
    }

    const next = await handler.execute(makeCtx({ date: '2026-06-01' }));
    expect(next.success).toBe(true);
    if (next.success) {
      expect(next.data).toMatchObject({ date: '2026-06-01', day_of_week: 'Monday' });
    }
  });

  it('handles year boundary (Dec 31, 2026 → Jan 1, 2027)', async () => {
    const dec31 = await handler.execute(makeCtx({ date: '2026-12-31' }));
    expect(dec31.success).toBe(true);
    if (dec31.success) {
      expect(dec31.data).toMatchObject({ date: '2026-12-31', day_of_week: 'Thursday' });
    }

    const jan1 = await handler.execute(makeCtx({ date: '2027-01-01' }));
    expect(jan1.success).toBe(true);
    if (jan1.success) {
      expect(jan1.data).toMatchObject({ date: '2027-01-01', day_of_week: 'Friday' });
    }
  });

  it('handles leap year (Feb 29, 2028)', async () => {
    const result = await handler.execute(makeCtx({ date: '2028-02-29' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ date: '2028-02-29', day_of_week: 'Tuesday' });
    }
  });

  it('falls back to UTC when timezone is not set', async () => {
    const ctx = makeCtx({ date: '2026-05-19' });
    (ctx as Record<string, unknown>).timezone = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      // Day-of-week should still be correct — dates don't change with timezone
      expect(result.data).toMatchObject({ date: '2026-05-19', day_of_week: 'Tuesday' });
    }
  });

  it('does not include correct/expected_day when expected_day is not provided', async () => {
    const result = await handler.execute(makeCtx({ date: '2026-05-19' }));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data).not.toHaveProperty('correct');
      expect(data).not.toHaveProperty('expected_day');
    }
  });

  it('includes displayTimezone when timezone is set', async () => {
    const result = await handler.execute(makeCtx({ date: '2026-05-19' }, 'America/Toronto'));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(typeof data.displayTimezone).toBe('string');
      expect(data.displayTimezone).toMatch(/UTC/);
    }
  });

  it('sets displayTimezone to null when timezone is not configured', async () => {
    const ctx = makeCtx({ date: '2026-05-19' });
    (ctx as Record<string, unknown>).timezone = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.displayTimezone).toBeNull();
    }
  });
});
