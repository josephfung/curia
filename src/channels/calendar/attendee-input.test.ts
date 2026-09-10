import { describe, it, expect } from 'vitest';
import {
  parseWritableAttendees,
  collectGuestListMismatches,
  guestListMismatchWarnings,
  ATTENDEE_STATUS_UNSUPPORTED,
} from './attendee-input.js';

describe('parseWritableAttendees', () => {
  it('accepts email and optional name', () => {
    const parsed = parseWritableAttendees([
      { email: ' a@example.test ', name: 'A' },
      { email: 'b@example.test' },
    ]);
    expect(parsed).toEqual({
      ok: true,
      attendees: [
        { email: 'a@example.test', name: 'A' },
        { email: 'b@example.test' },
      ],
    });
  });

  it('rejects RSVP status fields', () => {
    const parsed = parseWritableAttendees([{ email: 'a@example.test', status: 'yes' }]);
    expect(parsed).toEqual({ ok: false, error: ATTENDEE_STATUS_UNSUPPORTED });
  });
});

describe('collectGuestListMismatches', () => {
  it('does not throw when a returned participant has no email', () => {
    expect(() => collectGuestListMismatches(
      [{ email: 'a@example.test' }],
      [{ email: 'a@example.test' }, { email: undefined }, { email: null }],
    )).not.toThrow();
  });

  it('reports missing requested emails and extra returned emails', () => {
    expect(collectGuestListMismatches(
      [{ email: 'a@example.test' }, { email: 'b@example.test' }],
      [{ email: 'a@example.test' }, { email: 'organizer@example.test' }],
    )).toEqual({
      missing: ['b@example.test'],
      extra: ['organizer@example.test'],
    });
  });
});

describe('guestListMismatchWarnings', () => {
  it('tells the caller the write already applied', () => {
    const warnings = guestListMismatchWarnings(['b@example.test'], ['organizer@example.test']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/already applied/i);
    expect(warnings[1]).toMatch(/do not retry/i);
  });
});
