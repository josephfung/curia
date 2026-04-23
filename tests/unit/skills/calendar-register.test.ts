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

  it('returns failure when contact_id is missing', async () => {
    const contactService = { linkCalendar: vi.fn() };
    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Personal', is_primary: true },
        {
          contactService: contactService as never,
          caller: { contactId: 'caller-contact', role: 'ceo', channel: 'email' },
        },
      ),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('contact_id');
    }
    // Crucially: linkCalendar should NOT have been called
    expect(contactService.linkCalendar).not.toHaveBeenCalled();
  });

  it('returns failure when contact_id is whitespace-only', async () => {
    const contactService = { linkCalendar: vi.fn() };
    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Personal', contact_id: '   ' },
        { contactService: contactService as never },
      ),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('contact_id');
    }
    expect(contactService.linkCalendar).not.toHaveBeenCalled();
  });

  it('returns failure when contact_id is missing even without caller context', async () => {
    const contactService = { linkCalendar: vi.fn() };
    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-holidays', label: 'Holidays' },
        { contactService: contactService as never },
      ),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('contact_id');
    }
    expect(contactService.linkCalendar).not.toHaveBeenCalled();
  });

  it('returns failure when label exceeds 200 characters', async () => {
    const contactService = { linkCalendar: vi.fn() };
    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'x'.repeat(201) },
        { contactService: contactService as never },
      ),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('200 characters');
    }
  });

  it('returns a readable error when the calendar is already registered (Postgres 23505)', async () => {
    // Simulate the Postgres unique_violation error for the nylas_calendar_id constraint.
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'contact_calendars_nylas_calendar_id_key',
    });
    const contactService = { linkCalendar: vi.fn().mockRejectedValue(pgError) };

    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Work', contact_id: 'contact-abc' },
        { contactService: contactService as never },
      ),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('already registered');
      expect(result.error).toContain('cal-1');
    }
  });

  it('returns a readable error when contact already has a primary calendar (Postgres 23505)', async () => {
    // Simulate the partial unique index violation for is_primary = true.
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'idx_contact_calendars_primary',
    });
    const contactService = { linkCalendar: vi.fn().mockRejectedValue(pgError) };

    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Work', contact_id: 'contact-abc', is_primary: true },
        { contactService: contactService as never },
      ),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('already has a primary calendar');
      expect(result.error).toContain('contact-abc');
    }
  });

  it('falls through to generic error for non-23505 failures', async () => {
    const contactService = {
      linkCalendar: vi.fn().mockRejectedValue(new Error('connection refused')),
    };

    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Work', contact_id: 'contact-abc' },
        { contactService: contactService as never },
      ),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('connection refused');
    }
  });
});
