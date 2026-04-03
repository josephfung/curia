// tests/unit/skills/calendar-register.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CalendarRegisterHandler } from '../../../skills/calendar-register/handler.js';
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

describe('CalendarRegisterHandler', () => {
  const handler = new CalendarRegisterHandler();

  it('returns failure when contactService is not available', async () => {
    const result = await handler.execute(makeCtx({ nylas_calendar_id: 'cal-1', label: 'Work' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('infrastructure access');
    }
  });

  it('returns failure when nylas_calendar_id is missing', async () => {
    const contactService = { linkCalendar: vi.fn() };
    const result = await handler.execute(
      makeCtx({ label: 'Work' }, { contactService: contactService as never }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('nylas_calendar_id');
    }
  });

  it('returns failure when label is missing', async () => {
    const contactService = { linkCalendar: vi.fn() };
    const result = await handler.execute(
      makeCtx({ nylas_calendar_id: 'cal-1' }, { contactService: contactService as never }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('label');
    }
  });

  it('registers a calendar linked to an explicit contact_id', async () => {
    const linkedCalendar = {
      id: 'link-uuid',
      nylasCalendarId: 'cal-1',
      contactId: 'contact-abc',
      label: 'Work',
      isPrimary: false,
      readOnly: false,
      timezone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const contactService = { linkCalendar: vi.fn().mockResolvedValue(linkedCalendar) };

    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Work', contact_id: 'contact-abc' },
        { contactService: contactService as never },
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        nylas_calendar_id: 'cal-1',
        contact_id: 'contact-abc',
        label: 'Work',
        is_primary: false,
      });
    }
    expect(contactService.linkCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ nylasCalendarId: 'cal-1', contactId: 'contact-abc', label: 'Work' }),
    );
  });

  it('defaults contact_id to the caller when not provided', async () => {
    const linkedCalendar = {
      id: 'link-uuid',
      nylasCalendarId: 'cal-1',
      contactId: 'caller-contact',
      label: 'Personal',
      isPrimary: true,
      readOnly: false,
      timezone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const contactService = { linkCalendar: vi.fn().mockResolvedValue(linkedCalendar) };

    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Personal', is_primary: true },
        {
          contactService: contactService as never,
          caller: { contactId: 'caller-contact', channel: 'email', identifier: 'joseph@josephfung.ca' },
        },
      ),
    );

    expect(result.success).toBe(true);
    expect(contactService.linkCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'caller-contact', isPrimary: true }),
    );
  });

  it('uses null contact_id when no contact_id and no caller', async () => {
    const linkedCalendar = {
      id: 'link-uuid',
      nylasCalendarId: 'cal-holidays',
      contactId: null,
      label: 'Holidays',
      isPrimary: false,
      readOnly: true,
      timezone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const contactService = { linkCalendar: vi.fn().mockResolvedValue(linkedCalendar) };

    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-holidays', label: 'Holidays' },
        { contactService: contactService as never },
      ),
    );

    expect(result.success).toBe(true);
    expect(contactService.linkCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: null }),
    );
  });

  it('surfaces errors from linkCalendar (e.g. duplicate calendar)', async () => {
    const contactService = {
      linkCalendar: vi.fn().mockRejectedValue(new Error('duplicate key value violates unique constraint')),
    };

    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Work' },
        { contactService: contactService as never },
      ),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('duplicate key');
    }
  });

  it('surfaces errors when contact already has a primary calendar', async () => {
    const contactService = {
      linkCalendar: vi.fn().mockRejectedValue(new Error('Contact contact-abc already has a primary calendar')),
    };

    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Work', contact_id: 'contact-abc', is_primary: true },
        { contactService: contactService as never },
      ),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('already has a primary calendar');
    }
  });
});
