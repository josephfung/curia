// handler.test.ts — unit tests for calendar-holds-sweep skill.
//
// TDD: tests written before the implementation.
// All calls use a fixed nowMs in the input so staleness checks are deterministic.

import { describe, it, expect, vi } from 'vitest';
import { CalendarHoldsSweepHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { createSilentLogger } from '../../src/logger.js';

// ---------------------------------------------------------------------------
// Fixed test-time reference
// ---------------------------------------------------------------------------

// All fixture timestamps are relative to this fixed "now".
// nowMs: 2026-06-25T12:00:00Z as Unix milliseconds
const NOW_MS = 1750852800000; // 2026-06-25T12:00:00Z
const NOW_UNIX = NOW_MS / 1000; // 1750852800

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock NylasCalendarEvent-like object.
 *
 * @param overrides.slotOffset  Hours offset from NOW_UNIX for startTime.
 *                              Negative = past, positive = future.
 * @param overrides.slotDuration  Duration in hours. Default 1.
 * @param overrides.createdDaysAgo  How many days ago the hold was created.
 *                                  0 = now, 8 = 8 days ago (exceeds 7-day default).
 * @param overrides.isHold  Whether to attach curia-hold metadata.
 */
function makeEvent(opts: {
  id: string;
  slotOffset: number;       // hours from NOW_UNIX: negative = past
  slotDuration?: number;    // hours, default 1
  createdDaysAgo?: number;  // default 0 (now)
  isHold?: boolean;         // default true
}): {
  id: string;
  startTime: number;
  endTime: number;
  metadata: Record<string, string> | null;
} {
  const durationH = opts.slotDuration ?? 1;
  const startTime = NOW_UNIX + opts.slotOffset * 3600;
  const endTime = startTime + durationH * 3600;

  const createdDaysAgo = opts.createdDaysAgo ?? 0;
  const createdAtMs = NOW_MS - createdDaysAgo * 86_400_000;
  const createdAtIso = new Date(createdAtMs).toISOString();

  const isHold = opts.isHold ?? true;
  const metadata: Record<string, string> | null = isHold
    ? { 'curia-hold': 'true', 'created-at': createdAtIso }
    : null;

  return { id: opts.id, startTime, endTime, metadata };
}

// The four fixture events used across tests:
//
//   pastHold    — hold event whose slot ended 2 hours ago         → STALE (slot past)
//   freshHold   — hold event in the future, created today          → not stale
//   oldHold     — hold event in the future, but created 8 days ago → STALE (age > 7d)
//   realMeeting — non-hold event (no curia-hold metadata), past    → not a hold (skip)
//
// Expected sweep result: deleteEvent called for pastHold and oldHold only.
// scanned = 3 (three hold events); expired = 2.
const pastHold = makeEvent({ id: 'evt-past',    slotOffset: -3,  slotDuration: 1, createdDaysAgo: 0 });
const freshHold = makeEvent({ id: 'evt-fresh',  slotOffset: +2,  slotDuration: 1, createdDaysAgo: 0 });
const oldHold   = makeEvent({ id: 'evt-old',    slotOffset: +48, slotDuration: 1, createdDaysAgo: 8 });
const realMeeting = makeEvent({ id: 'evt-real', slotOffset: -5,  slotDuration: 1, isHold: false });

// ---------------------------------------------------------------------------
// makeCtx helper
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: {
      contactId: 'deadbeef-0000-0000-0000-000000000001',
      nowMs: NOW_MS, // inject fixed time for deterministic staleness checks
    },
    secret: () => { throw new Error('no secret in test'); },
    log: createSilentLogger(),
    contactService: {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-work' },
      ]),
    } as unknown as SkillContext['contactService'],
    nylasCalendarClient: {
      listEvents: vi.fn().mockResolvedValue([pastHold, freshHold, oldHold, realMeeting]),
      deleteEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as SkillContext['nylasCalendarClient'],
    ...overrides,
  } as SkillContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CalendarHoldsSweepHandler — core sweep logic', () => {
  it('deletes pastHold and oldHold; leaves freshHold and realMeeting untouched', async () => {
    const handler = new CalendarHoldsSweepHandler();
    const ctx = makeCtx();

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { scanned: number; expired: number } }).data;
    expect(data.expired).toBe(2);
    // scanned counts hold events only (not realMeeting)
    expect(data.scanned).toBe(3);

    const deleteEvent = ctx.nylasCalendarClient!.deleteEvent as ReturnType<typeof vi.fn>;
    // deleteEvent must have been called exactly for the two stale holds
    expect(deleteEvent).toHaveBeenCalledTimes(2);
    const deletedIds = deleteEvent.mock.calls.map((c: unknown[]) => (c as [string, string, boolean])[1]);
    expect(deletedIds).toContain('evt-past');
    expect(deletedIds).toContain('evt-old');
    // Fresh hold must NOT have been deleted
    expect(deletedIds).not.toContain('evt-fresh');
    // Real meeting (non-hold) must NOT have been deleted
    expect(deletedIds).not.toContain('evt-real');
  });

  it('passes notifyAttendees=false to deleteEvent (no cancellation emails)', async () => {
    const handler = new CalendarHoldsSweepHandler();
    const ctx = makeCtx();

    await handler.execute(ctx);

    const deleteEvent = ctx.nylasCalendarClient!.deleteEvent as ReturnType<typeof vi.fn>;
    for (const call of deleteEvent.mock.calls as [string, string, boolean][]) {
      // Third argument must be false — we never notify for holds
      expect(call[2]).toBe(false);
    }
  });

  it('returns scanned=0, expired=0 when the calendar has no events', async () => {
    const handler = new CalendarHoldsSweepHandler();
    const ctx = makeCtx({
      nylasCalendarClient: {
        listEvents: vi.fn().mockResolvedValue([]),
        deleteEvent: vi.fn(),
      } as unknown as SkillContext['nylasCalendarClient'],
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { scanned: number; expired: number } }).data;
    expect(data.scanned).toBe(0);
    expect(data.expired).toBe(0);
  });

  it('honours custom maxAgeDays: a hold 6 days old is NOT stale when maxAgeDays=7', async () => {
    const handler = new CalendarHoldsSweepHandler();
    // Build an event created 6 days ago with a future slot
    const sixDayOldHold = makeEvent({ id: 'evt-6d', slotOffset: +24, createdDaysAgo: 6 });
    const ctx = makeCtx({
      input: {
        contactId: 'deadbeef-0000-0000-0000-000000000001',
        maxAgeDays: 7,
        nowMs: NOW_MS,
      },
      nylasCalendarClient: {
        listEvents: vi.fn().mockResolvedValue([sixDayOldHold]),
        deleteEvent: vi.fn(),
      } as unknown as SkillContext['nylasCalendarClient'],
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { scanned: number; expired: number } }).data;
    expect(data.scanned).toBe(1);
    expect(data.expired).toBe(0); // 6d < 7d threshold — not stale
    expect(ctx.nylasCalendarClient!.deleteEvent).not.toHaveBeenCalled();
  });

  it('a hold exactly 7 days old is NOT stale (isHoldStale uses strict-greater-than)', async () => {
    const handler = new CalendarHoldsSweepHandler();
    // Exactly 7 days ago
    const sevenDayOldHold = makeEvent({ id: 'evt-7d', slotOffset: +24, createdDaysAgo: 7 });
    const ctx = makeCtx({
      input: { contactId: 'deadbeef-0000-0000-0000-000000000001', maxAgeDays: 7, nowMs: NOW_MS },
      nylasCalendarClient: {
        listEvents: vi.fn().mockResolvedValue([sevenDayOldHold]),
        deleteEvent: vi.fn(),
      } as unknown as SkillContext['nylasCalendarClient'],
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { scanned: number; expired: number } }).data;
    expect(data.expired).toBe(0); // exactly at boundary — not stale per isHoldStale semantics
  });
});

describe('CalendarHoldsSweepHandler — resilience', () => {
  it('a deleteEvent rejection on one hold does not abort the sweep; other stale hold is still deleted', async () => {
    const handler = new CalendarHoldsSweepHandler();

    // deleteEvent succeeds for pastHold (evt-past) but rejects for oldHold (evt-old)
    const deleteEvent = vi.fn().mockImplementation(
      (_calId: string, eventId: string) => {
        if (eventId === 'evt-old') {
          return Promise.reject(new Error('Nylas API error: calendar grant revoked'));
        }
        return Promise.resolve();
      },
    );

    const ctx = makeCtx({
      nylasCalendarClient: {
        listEvents: vi.fn().mockResolvedValue([pastHold, freshHold, oldHold, realMeeting]),
        deleteEvent,
      } as unknown as SkillContext['nylasCalendarClient'],
    });

    const result = await handler.execute(ctx);

    // Sweep must succeed overall even though one delete failed
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { scanned: number; expired: number } }).data;
    expect(data.scanned).toBe(3);
    // Only the successful delete is counted — the failed one is not
    expect(data.expired).toBe(1);
    // Both stale holds were attempted
    expect(deleteEvent).toHaveBeenCalledTimes(2);
  });

  it('returns success:false when contactId is missing', async () => {
    const handler = new CalendarHoldsSweepHandler();
    const ctx = makeCtx({
      input: { nowMs: NOW_MS }, // no contactId
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('contactId');
  });

  it('returns success:true with scanned=0, expired=0 when getCalendarsForContact returns empty', async () => {
    const handler = new CalendarHoldsSweepHandler();
    const ctx = makeCtx({
      contactService: {
        getCalendarsForContact: vi.fn().mockResolvedValue([]),
      } as unknown as SkillContext['contactService'],
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { scanned: number; expired: number } }).data;
    expect(data.scanned).toBe(0);
    expect(data.expired).toBe(0);
  });

  it('returns success:false when nylasCalendarClient is not configured', async () => {
    const handler = new CalendarHoldsSweepHandler();
    const ctx = makeCtx({
      nylasCalendarClient: undefined,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Calendar not configured');
  });

  it('never throws — returns success:false when getCalendarsForContact rejects', async () => {
    const handler = new CalendarHoldsSweepHandler();
    const ctx = makeCtx({
      contactService: {
        getCalendarsForContact: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      } as unknown as SkillContext['contactService'],
    });

    // Must resolve (not reject) — skills never throw
    await expect(handler.execute(ctx)).resolves.toBeDefined();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('listEvents failure on one calendar does not abort sweep of other calendars', async () => {
    const handler = new CalendarHoldsSweepHandler();
    const ctx = makeCtx({
      contactService: {
        // Two calendars returned
        getCalendarsForContact: vi.fn().mockResolvedValue([
          { nylasCalendarId: 'cal-work' },
          { nylasCalendarId: 'cal-personal' },
        ]),
      } as unknown as SkillContext['contactService'],
      nylasCalendarClient: {
        // cal-work fails; cal-personal succeeds with one stale hold
        listEvents: vi.fn().mockImplementation((_calId: string) => {
          if (_calId === 'cal-work') {
            return Promise.reject(new Error('Nylas 401'));
          }
          return Promise.resolve([pastHold]);
        }),
        deleteEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as SkillContext['nylasCalendarClient'],
    });

    const result = await handler.execute(ctx);

    // Should still succeed and count the events from the working calendar
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { scanned: number; expired: number } }).data;
    expect(data.scanned).toBe(1);
    expect(data.expired).toBe(1);
    expect(ctx.nylasCalendarClient!.deleteEvent).toHaveBeenCalledWith('cal-personal', 'evt-past', false);
  });
});
