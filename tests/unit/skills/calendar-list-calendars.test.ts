// tests/unit/skills/calendar-list-calendars.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CalendarListCalendarsHandler } from '../../../skills/calendar-list-calendars/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

describe('CalendarListCalendarsHandler', () => {
  const handler = new CalendarListCalendarsHandler();

  it('returns failure when nylasCalendarClient is not available', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Calendar not configured');
    }
  });

  it('returns calendars annotated with registry info', async () => {
    const nylasCalendarClient = {
      listCalendars: vi.fn().mockResolvedValue([
        { id: 'cal-1', name: 'CEO Work', description: '', timezone: 'America/Toronto', isPrimary: true, readOnly: false, isOwnedByUser: false },
        { id: 'cal-2', name: 'Holidays', description: 'Company holidays', timezone: 'America/Toronto', isPrimary: false, readOnly: true, isOwnedByUser: false },
      ]),
    };
    const contactService = {
      resolveCalendar: vi.fn()
        .mockResolvedValueOnce({ contactId: 'contact-1', label: 'Work', isPrimary: true, readOnly: false })
        .mockResolvedValueOnce(null),
      getContact: vi.fn().mockResolvedValue({ id: 'contact-1', displayName: 'Joseph Fung' }),
    };

    const result = await handler.execute(makeCtx(
      {},
      { nylasCalendarClient: nylasCalendarClient as never, contactService: contactService as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { calendars: Array<{ id: string; registered: boolean; contactName?: string }> };
      expect(data.calendars).toHaveLength(2);
      expect(data.calendars[0].registered).toBe(true);
      expect(data.calendars[0].contactName).toBe('Joseph Fung');
      expect(data.calendars[1].registered).toBe(false);
    }
  });

  it('handles Nylas API errors gracefully', async () => {
    const nylasCalendarClient = {
      listCalendars: vi.fn().mockRejectedValue(new Error('Nylas 500')),
    };

    const result = await handler.execute(makeCtx(
      {},
      { nylasCalendarClient: nylasCalendarClient as never, contactService: {} as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Nylas 500');
    }
  });
});
