// tests/unit/skills/calendar-register.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CalendarRegisterHandler } from '../../../skills/calendar/tools/calendar-register/handler.js';
import type { ToolContext } from '../../../src/skills/types.js';
import pino from 'pino';
import { calendarMailbox, routerFixture, singleMailboxRouter, TEST_PRINCIPAL_CONTACT_ID } from '../../../skills/_shared/calendar-router-test-helpers.js';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<ToolContext>,
): ToolContext {
  return {
    toolName: 'calendar-register',
    toolVersion: '1.0.0',
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    calendarRouter: singleMailboxRouter({}),
    ...overrides,
  };
}

/** Two live mailboxes: work (default) and personal, each owning its address's calendar. */
function twoMailboxRouter(registry: Parameters<typeof routerFixture>[0]['registry'] = {}) {
  return routerFixture({
    mailboxes: [
      calendarMailbox('work', 'Work', 'ceo@work.example.com', true),
      calendarMailbox('personal', 'Personal', 'ceo@personal.example.com'),
    ],
    clients: { work: {}, personal: {} },
    registry,
  });
}

function linked(nylasCalendarId: string, principalMailboxId: string | null) {
  return {
    id: 'link-uuid', nylasCalendarId, contactId: 'contact-abc', label: 'Cal', isPrimary: false,
    readOnly: false, timezone: null, principalMailboxId, createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('CalendarRegisterHandler', () => {
  const handler = new CalendarRegisterHandler();

  it('returns failure when contactService is not available', async () => {
    const result = await handler.execute(makeCtx({ nylas_calendar_id: 'cal-1', label: 'Work' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('universal service');
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
    const contactService = {
      linkCalendar: vi.fn().mockRejectedValue(pgError),
      resolveCalendar: vi.fn().mockResolvedValue({ contactId: 'contact-abc', label: 'Work', isPrimary: false, readOnly: false, principalMailboxId: 'work' }),
      setCalendarMailbox: vi.fn(),
    };

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
      expect(result.error).toContain('"work" mailbox');
    }
    expect(contactService.setCalendarMailbox).not.toHaveBeenCalled();
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

  describe('mailbox placement (#2475)', () => {
    it('registers through the single live mailbox when no mailbox is given', async () => {
      const contactService = { linkCalendar: vi.fn().mockResolvedValue(linked('cal-1', 'work')) };
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Work', contact_id: 'contact-abc' },
        { contactService: contactService as never },
      ));
      expect(result.success).toBe(true);
      expect(contactService.linkCalendar).toHaveBeenCalledWith(expect.objectContaining({ principalMailboxId: 'work' }));
      if (result.success) expect(result.data).toMatchObject({ mailbox: 'work' });
    });

    it('needs a mailbox for a calendar no mailbox owns when two are connected', async () => {
      const contactService = { linkCalendar: vi.fn() };
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'team@group.calendar.google.com', label: 'Team', contact_id: 'contact-abc' },
        { contactService: contactService as never, calendarRouter: twoMailboxRouter() },
      ));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('pass mailbox');
        expect(result.error).toContain('work (Work)');
        expect(result.error).toContain('personal (Personal)');
      }
      expect(contactService.linkCalendar).not.toHaveBeenCalled();
    });

    it('registers through the named mailbox', async () => {
      const contactService = { linkCalendar: vi.fn().mockResolvedValue(linked('team@group.calendar.google.com', 'personal')) };
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'team@group.calendar.google.com', label: 'Team', contact_id: 'contact-abc', mailbox: 'personal' },
        { contactService: contactService as never, calendarRouter: twoMailboxRouter() },
      ));
      expect(result.success).toBe(true);
      expect(contactService.linkCalendar).toHaveBeenCalledWith(expect.objectContaining({ principalMailboxId: 'personal' }));
    });

    it('owning grant wins on register: a mailbox address registers to that mailbox whatever mailbox says', async () => {
      const contactService = { linkCalendar: vi.fn().mockResolvedValue(linked('ceo@personal.example.com', 'personal')) };
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'CEO@personal.example.com', label: 'Personal', contact_id: 'contact-abc', mailbox: 'work' },
        { contactService: contactService as never, calendarRouter: twoMailboxRouter() },
      ));
      expect(result.success).toBe(true);
      expect(contactService.linkCalendar).toHaveBeenCalledWith(expect.objectContaining({ principalMailboxId: 'personal' }));
    });

    it('owning grant wins on register: an existing row under another mailbox is rewritten to the owner', async () => {
      const dup = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'contact_calendars_nylas_calendar_id_key' });
      const contactService = {
        linkCalendar: vi.fn().mockRejectedValue(dup),
        resolveCalendar: vi.fn().mockResolvedValue({ contactId: 'contact-abc', label: 'Personal', isPrimary: true, readOnly: false, principalMailboxId: 'work' }),
        setCalendarMailbox: vi.fn().mockResolvedValue(true),
        getCalendarsForMailbox: vi.fn().mockResolvedValue([{ id: 'row-1', nylasCalendarId: 'ceo@personal.example.com' }]),
      };
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'ceo@personal.example.com', label: 'Personal', contact_id: 'contact-abc' },
        { contactService: contactService as never, calendarRouter: twoMailboxRouter() },
      ));
      expect(result.success).toBe(true);
      expect(contactService.setCalendarMailbox).toHaveBeenCalledWith('ceo@personal.example.com', 'personal');
      if (result.success) expect(result.data).toMatchObject({ calendar_id: 'row-1', mailbox: 'personal', moved_from_mailbox: 'work', updated: ['mailbox'] });
    });

    it('a principal calendar must be listed exactly as given: a case variant is refused', async () => {
      const contactService = { linkCalendar: vi.fn() };
      const router = routerFixture({ clients: { work: { listCalendars: async () => [{ id: 'AbC-cal', isPrimary: false }] } } });
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'abc-cal', label: 'Team', contact_id: TEST_PRINCIPAL_CONTACT_ID },
        { contactService: contactService as never, calendarRouter: router },
      ));
      expect(result.success).toBe(false);
      expect(contactService.linkCalendar).not.toHaveBeenCalled();
    });

    it('moving the principal\'s existing row checks the target account can see it, whoever the request named', async () => {
      const dup = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'contact_calendars_nylas_calendar_id_key' });
      const contactService = {
        linkCalendar: vi.fn().mockRejectedValue(dup),
        resolveCalendar: vi.fn().mockResolvedValue({ contactId: TEST_PRINCIPAL_CONTACT_ID, label: 'Team', isPrimary: false, readOnly: false, principalMailboxId: null }),
        setCalendarMailbox: vi.fn().mockResolvedValue(true),
        getCalendarsForMailbox: vi.fn().mockResolvedValue([]),
      };
      const router = routerFixture({
        mailboxes: [calendarMailbox('work', 'Work', 'ceo@work.example.com', true), calendarMailbox('personal', 'Personal', 'ceo@personal.example.com')],
        clients: { work: {}, personal: { listCalendars: async () => [] } },
      });
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'team@group.calendar.google.com', label: 'Team', contact_id: 'contact-other', mailbox: 'personal' },
        { contactService: contactService as never, calendarRouter: router },
      ));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('not one the "personal" mailbox\'s account can see');
      expect(contactService.setCalendarMailbox).not.toHaveBeenCalled();
    });

    it('a move whose row cannot be read back is still a success, with a warning', async () => {
      const dup = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'contact_calendars_nylas_calendar_id_key' });
      const contactService = {
        linkCalendar: vi.fn().mockRejectedValue(dup),
        resolveCalendar: vi.fn().mockResolvedValue({ contactId: 'contact-abc', label: 'Personal', isPrimary: true, readOnly: false, principalMailboxId: 'work' }),
        setCalendarMailbox: vi.fn().mockResolvedValue(true),
        getCalendarsForMailbox: vi.fn().mockRejectedValue(new Error('db down')),
      };
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'ceo@personal.example.com', label: 'Personal', contact_id: 'contact-abc' },
        { contactService: contactService as never, calendarRouter: twoMailboxRouter() },
      ));
      expect(contactService.setCalendarMailbox).toHaveBeenCalledWith('ceo@personal.example.com', 'personal');
      expect(result).toMatchObject({ success: true, data: { calendar_id: null, mailbox: 'personal', moved_from_mailbox: 'work', warning: expect.stringContaining('could not be read back') } });
    });

    it('a move that updates no row (the registration vanished) is not reported as moved', async () => {
      const dup = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'contact_calendars_nylas_calendar_id_key' });
      const contactService = {
        linkCalendar: vi.fn().mockRejectedValue(dup),
        resolveCalendar: vi.fn().mockResolvedValue({ contactId: 'contact-abc', label: 'Personal', isPrimary: true, readOnly: false, principalMailboxId: 'work' }),
        setCalendarMailbox: vi.fn().mockResolvedValue(false),
        getCalendarsForMailbox: vi.fn(),
      };
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'ceo@personal.example.com', label: 'Personal', contact_id: 'contact-abc' },
        { contactService: contactService as never, calendarRouter: twoMailboxRouter() },
      ));
      expect(result).toMatchObject({ success: false, error: expect.stringContaining('no longer registered') });
      expect(contactService.getCalendarsForMailbox).not.toHaveBeenCalled();
    });

    it('refuses an unknown mailbox, never falling back to the default', async () => {
      const contactService = { linkCalendar: vi.fn() };
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Work', contact_id: 'contact-abc', mailbox: 'nope' },
        { contactService: contactService as never },
      ));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('Unknown mailbox "nope"');
      expect(contactService.linkCalendar).not.toHaveBeenCalled();
    });

    it('refuses the primary alias', async () => {
      const contactService = { linkCalendar: vi.fn() };
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'primary', label: 'Work', contact_id: 'contact-abc' },
        { contactService: contactService as never },
      ));
      expect(result.success).toBe(false);
      expect(contactService.linkCalendar).not.toHaveBeenCalled();
    });

    it('registers with no mailbox while the deferred-migration fallback is served', async () => {
      const contactService = { linkCalendar: vi.fn().mockResolvedValue(linked('cal-1', null)) };
      const result = await handler.execute(makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Work', contact_id: 'contact-abc' },
        { contactService: contactService as never, calendarRouter: routerFixture({ clients: { work: {} }, fallbackActive: true }) },
      ));
      expect(result.success).toBe(true);
      expect(contactService.linkCalendar).toHaveBeenCalledWith(expect.objectContaining({ principalMailboxId: null }));
    });
  });
});
