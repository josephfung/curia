// handler.test.ts — unit tests for calendar-list-events skill.

import { describe, it, expect, vi } from 'vitest';
import { CalendarListEventsHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { createSilentLogger } from '../../src/logger.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: {
      timeMin: '2026-05-26T00:00:00Z',
      timeMax: '2026-05-26T23:59:59Z',
    },
    secret: () => { throw new Error('no secret in test'); },
    log: createSilentLogger(),
    nylasCalendarClient: {
      listEvents: vi.fn().mockResolvedValue([]),
    } as unknown as SkillContext['nylasCalendarClient'],
    ...overrides,
  } as SkillContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CalendarListEventsHandler — system caller guard', () => {
  it('returns a clear error when ctx.caller.contactId is "system" and no calendarId is provided', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn().mockRejectedValue(
        new Error('invalid input syntax for type uuid: "system"'),
      ),
    } as unknown as SkillContext['contactService'];

    const result = await handler.execute(makeCtx({
      caller: { contactId: 'system', role: null, channel: 'internal' },
      contactService,
    }));

    expect(result.success).toBe(false);
    // Should surface an actionable error, not a raw Postgres UUID parse error
    expect((result as { error: string }).error).toContain('calendarId');
    // contactService should never have been called — the guard fires before the DB hit
    expect(contactService!.getCalendarsForContact).not.toHaveBeenCalled();
  });

  it('returns a clear error when ctx.caller.contactId is "primary-user" and no calendarId is provided', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn(),
    } as unknown as SkillContext['contactService'];

    const result = await handler.execute(makeCtx({
      caller: { contactId: 'primary-user', role: 'ceo', channel: 'cli' },
      contactService,
    }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('calendarId');
    expect(contactService!.getCalendarsForContact).not.toHaveBeenCalled();
  });

  it('does NOT fire the guard for a valid UUID contactId — proceeds to getCalendarsForContact', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-work' },
      ]),
    } as unknown as SkillContext['contactService'];

    const result = await handler.execute(makeCtx({
      caller: { contactId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', role: 'ceo', channel: 'signal' },
      contactService,
      nylasCalendarClient: {
        listEvents: vi.fn().mockResolvedValue([]),
      } as unknown as SkillContext['nylasCalendarClient'],
    }));

    // Guard must not have fired — contactService was called with the UUID
    expect(contactService!.getCalendarsForContact).toHaveBeenCalledWith('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    // Result: no events but success (the calendar exists, range is empty)
    expect(result.success).toBe(true);
  });
});
