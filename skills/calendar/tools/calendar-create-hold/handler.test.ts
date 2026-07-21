// skills/calendar-create-hold/handler.test.ts
//
// Unit tests for the calendar-create-hold skill handler.
// Tests the three scenarios from the brief:
//   - Toggle ON (null or 'true'): places hold, returns held:true
//   - Toggle OFF ('false'): returns held:false without calling createEvent
//   - createEvent throws: returns held:false but still success:true (never breaks caller)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalendarCreateHoldHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { EntityMemory } from '../../../../src/memory/entity-memory.js';
import type { Logger } from '../../../../src/logger.js';
import type { NylasCalendarEvent } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import { CURIA_HOLD_KEY } from '../../../../src/channels/calendar/holds.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal EntityMemory mock that returns the given ConfigStore value
 *  for the 'calendar_holds'/'enabled' key (or null when storedValue is null). */
function makeEntityMemory(storedValue: string | null): EntityMemory {
  const anchorNode = {
    id: 'anchor-1',
    label: 'config:calendar_holds',
    type: 'concept',
    properties: {},
  };
  const factNode =
    storedValue !== null
      ? {
          id: 'fact-1',
          label: 'enabled',
          properties: { key: 'enabled', value: storedValue, namespace: 'calendar_holds' },
          temporal: { lastConfirmedAt: new Date() },
        }
      : undefined;

  return {
    findEntities: vi.fn().mockResolvedValue([anchorNode]),
    getFacts: vi.fn().mockResolvedValue(factNode ? [factNode] : []),
    storeFact: vi.fn().mockResolvedValue({ stored: true, action: 'created' }),
  } as unknown as EntityMemory;
}

/** Build a mock NylasCalendarEvent returned from createEvent. */
function makeCreatedEvent(overrides?: Partial<NylasCalendarEvent>): NylasCalendarEvent {
  return {
    id: 'hold-event-id-123',
    title: 'HOLD (TBC): test meeting',
    description: '',
    location: '',
    startTime: Math.floor(new Date('2026-06-25T14:30:00Z').getTime() / 1000),
    endTime: Math.floor(new Date('2026-06-25T15:30:00Z').getTime() / 1000),
    startDate: null,
    endDate: null,
    participants: [],
    conferencing: null,
    status: 'tentative',
    calendarId: 'cal-work',
    busy: true,
    metadata: {
      [CURIA_HOLD_KEY]: 'true',
      'created-at': new Date().toISOString(),
    },
    ...overrides,
  };
}

/** Build a ToolContext with configurable entityMemory and createEvent mock. */
function makeCtx(opts: {
  toggleValue: string | null;
  createEvent?: ReturnType<typeof vi.fn>;
  subject?: string;
  sourceRef?: string;
}): ToolContext {
  const createEvent = opts.createEvent ?? vi.fn().mockResolvedValue(makeCreatedEvent());
  return {
    input: {
      calendarId: 'cal-work',
      start: '2026-06-25T14:30:00Z',
      end: '2026-06-25T15:30:00Z',
      ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
      ...(opts.sourceRef !== undefined ? { sourceRef: opts.sourceRef } : {}),
    },
    secret: () => { throw new Error('no secret in test'); },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    entityMemory: makeEntityMemory(opts.toggleValue),
    nylasCalendarClient: {
      createEvent,
    } as unknown as ToolContext['nylasCalendarClient'],
    timezone: 'America/Toronto',
  } as unknown as ToolContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CalendarCreateHoldHandler -- toggle ON (null)', () => {
  let handler: CalendarCreateHoldHandler;
  beforeEach(() => { handler = new CalendarCreateHoldHandler(); });

  it('calls createEvent with busy:true, status:tentative, no attendees when toggle is null (default on)', async () => {
    const createEvent = vi.fn().mockResolvedValue(makeCreatedEvent());
    const ctx = makeCtx({ toggleValue: null, createEvent });

    const result = await handler.execute(ctx);

    expect(createEvent).toHaveBeenCalledOnce();
    const [calId, eventArg] = createEvent.mock.calls[0]!;
    expect(calId).toBe('cal-work');
    expect(eventArg.busy).toBe(true);
    expect(eventArg.status).toBe('tentative');
    // Hold has no attendees -- no invitations sent
    expect(eventArg.attendees).toBeUndefined();
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).held).toBe(true);
      expect((result.data as Record<string, unknown>).holdEventId).toBe('hold-event-id-123');
    }
  });

  it('prefixes the title with HOLD (TBC): when a subject is provided', async () => {
    const createEvent = vi.fn().mockResolvedValue(makeCreatedEvent({ title: 'HOLD (TBC): quarterly sync' }));
    const ctx = makeCtx({ toggleValue: null, createEvent, subject: 'quarterly sync' });

    await handler.execute(ctx);

    const [, eventArg] = createEvent.mock.calls[0]!;
    expect(eventArg.title).toBe('HOLD (TBC): quarterly sync');
  });

  it('uses a generic title when no subject is provided', async () => {
    const createEvent = vi.fn().mockResolvedValue(makeCreatedEvent({ title: 'HOLD (TBC): tentative' }));
    const ctx = makeCtx({ toggleValue: null, createEvent });

    await handler.execute(ctx);

    const [, eventArg] = createEvent.mock.calls[0]!;
    expect(eventArg.title).toMatch(/^HOLD \(TBC\):/);
  });

  it('attaches curia-hold metadata to the event', async () => {
    const createEvent = vi.fn().mockResolvedValue(makeCreatedEvent());
    const ctx = makeCtx({ toggleValue: null, createEvent });

    await handler.execute(ctx);

    const [, eventArg] = createEvent.mock.calls[0]!;
    expect(eventArg.metadata?.[CURIA_HOLD_KEY]).toBe('true');
    expect(eventArg.metadata?.['created-at']).toBeTruthy();
  });

  it('includes sourceRef in metadata when provided', async () => {
    const createEvent = vi.fn().mockResolvedValue(makeCreatedEvent());
    const ctx = makeCtx({ toggleValue: null, createEvent, sourceRef: 'msg-xyz' });

    await handler.execute(ctx);

    const [, eventArg] = createEvent.mock.calls[0]!;
    expect(eventArg.metadata?.['source-ref']).toBe('msg-xyz');
  });

  it('returns a non-empty display string labelled with the timezone', async () => {
    // Context uses America/Toronto with a June start date (UTC-04:00 / EDT).
    // formatDisplayTimezone returns "EDT (UTC-04:00)" for this combination,
    // so the display string must contain the UTC offset and displayTimezone must match.
    const ctx = makeCtx({ toggleValue: null });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      const display = data.display as string;
      expect(typeof display).toBe('string');
      expect(display.length).toBeGreaterThan(0);
      // Must contain the EDT UTC offset in the ISO timestamps (-04:00) or the abbreviation EDT.
      // This verifies the timezone label is actually derived from America/Toronto in June,
      // not just any uppercase sequence like "HOLD".
      const hasOffset = display.includes('-04:00');
      const hasAbbr = display.includes('EDT');
      expect(hasOffset || hasAbbr).toBe(true);
      // displayTimezone should also be present and contain the same timezone info
      const displayTimezone = data.displayTimezone as string;
      expect(typeof displayTimezone).toBe('string');
      const tzHasOffset = displayTimezone.includes('-04:00');
      const tzHasAbbr = displayTimezone.includes('EDT');
      expect(tzHasOffset || tzHasAbbr).toBe(true);
    }
  });
});

describe('CalendarCreateHoldHandler -- toggle ON (explicit true)', () => {
  let handler: CalendarCreateHoldHandler;
  beforeEach(() => { handler = new CalendarCreateHoldHandler(); });

  it('calls createEvent when toggle is explicitly set to "true"', async () => {
    const createEvent = vi.fn().mockResolvedValue(makeCreatedEvent());
    const ctx = makeCtx({ toggleValue: 'true', createEvent });

    const result = await handler.execute(ctx);

    expect(createEvent).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).held).toBe(true);
    }
  });
});

describe('CalendarCreateHoldHandler -- toggle OFF ("false")', () => {
  let handler: CalendarCreateHoldHandler;
  beforeEach(() => { handler = new CalendarCreateHoldHandler(); });

  it('does NOT call createEvent when toggle is "false"', async () => {
    const createEvent = vi.fn();
    const ctx = makeCtx({ toggleValue: 'false', createEvent });

    await handler.execute(ctx);

    expect(createEvent).not.toHaveBeenCalled();
  });

  it('returns held:false, holdEventId:null, reason:"holds disabled" when toggle is "false"', async () => {
    const ctx = makeCtx({ toggleValue: 'false' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.held).toBe(false);
      expect(data.holdEventId).toBeNull();
      expect(data.reason).toBe('holds disabled');
      // Display should still be populated even when disabled
      expect(typeof data.display).toBe('string');
      // displayTimezone must be present on held:false paths (Fix 1 coverage)
      expect(typeof data.displayTimezone).toBe('string');
      expect((data.displayTimezone as string).length).toBeGreaterThan(0);
    }
  });
});

describe('CalendarCreateHoldHandler -- createEvent throws', () => {
  let handler: CalendarCreateHoldHandler;
  beforeEach(() => { handler = new CalendarCreateHoldHandler(); });

  it('returns success:true with held:false when createEvent throws (hold failure must not break caller)', async () => {
    const createEvent = vi.fn().mockRejectedValue(new Error('Nylas API timeout'));
    const ctx = makeCtx({ toggleValue: null, createEvent });

    const result = await handler.execute(ctx);

    // MUST still be success:true -- hold failure is non-fatal
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.held).toBe(false);
      expect(data.holdEventId).toBeNull();
      // Reason should summarise the error
      expect(typeof data.reason).toBe('string');
      expect((data.reason as string).length).toBeGreaterThan(0);
      // Display should still be populated for display in the LLM reply
      expect(typeof data.display).toBe('string');
    }
  });

  it('logs the error when createEvent throws', async () => {
    const createEvent = vi.fn().mockRejectedValue(new Error('network error'));
    const ctx = makeCtx({ toggleValue: null, createEvent });

    await handler.execute(ctx);

    expect((ctx.log.error as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});

describe('CalendarCreateHoldHandler -- malformed timezone', () => {
  let handler: CalendarCreateHoldHandler;
  beforeEach(() => { handler = new CalendarCreateHoldHandler(); });

  it('resolves with success:true even when ctx.timezone is invalid (never throws)', async () => {
    // A malformed timezone like 'Not/AZone' causes toLocalIso / formatDisplayTimezone
    // to throw internally. The handler must catch that and return a ToolResult rather
    // than letting the rejection bubble up (skills must never throw).
    const createEvent = vi.fn().mockResolvedValue(makeCreatedEvent());
    const ctx = makeCtx({ toggleValue: null, createEvent });
    // Override the timezone to an invalid value.
    // Cast through unknown first — ToolContext has no index signature.
    (ctx as unknown as Record<string, unknown>).timezone = 'Not/AZone';

    const result = await expect(handler.execute(ctx)).resolves.toBeDefined();
    void result; // assertion is on the promise settling (resolves), not the value shape

    // Also verify the resolved value has success:true (the hold itself can succeed)
    const actual = await handler.execute(ctx);
    expect(actual.success).toBe(true);
  });
});

describe('CalendarCreateHoldHandler -- input validation', () => {
  let handler: CalendarCreateHoldHandler;
  beforeEach(() => { handler = new CalendarCreateHoldHandler(); });

  it('returns success:false when calendarId is missing', async () => {
    const ctx = makeCtx({ toggleValue: null });
    ctx.input = { start: '2026-06-25T14:30:00Z', end: '2026-06-25T15:30:00Z' };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('calendarId');
    }
  });

  it('returns success:false when start is missing', async () => {
    const ctx = makeCtx({ toggleValue: null });
    ctx.input = { calendarId: 'cal-work', end: '2026-06-25T15:30:00Z' };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('start');
    }
  });

  it('returns success:false when end is not after start', async () => {
    const ctx = makeCtx({ toggleValue: null });
    ctx.input = {
      calendarId: 'cal-work',
      start: '2026-06-25T15:30:00Z',
      end: '2026-06-25T14:30:00Z', // end before start
    };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('end');
    }
  });

  it('returns success:false when nylasCalendarClient is missing', async () => {
    const ctx = makeCtx({ toggleValue: null });
    // Remove the calendar client
    ctx.nylasCalendarClient = undefined;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
  });
});
