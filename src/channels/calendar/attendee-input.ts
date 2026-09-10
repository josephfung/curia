// attendee-input.ts — shared guest-list parsing for Nylas calendar writes.
//
// Attendees on create/update are membership only (email + optional name).
// RSVP status is not a writable field on this path; first-person RSVP is sendRsvp.

/** Guest-list entry for create/update. RSVP `status` is intentionally absent. */
export interface CalendarAttendeeInput {
  email: string;
  name?: string;
}

export const ATTENDEE_RSVP_STATUS_KEYS = ['status', 'responseStatus', 'participationStatus'] as const;

export const ATTENDEE_STATUS_UNSUPPORTED =
  'Attendee response status cannot be set through this Nylas calendar tool. ' +
  'Pass attendees as email and optional name only. For the principal\'s own RSVP, use calendar-respond-to-invite.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWritableAttendees(
  raw: unknown,
): { ok: true; attendees: CalendarAttendeeInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'Invalid input: attendees must be an array' };
  }
  const attendees: CalendarAttendeeInput[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      return { ok: false, error: 'Invalid input: each attendee must be an object with email and optional name' };
    }
    if (ATTENDEE_RSVP_STATUS_KEYS.some((key) => key in item)) {
      return { ok: false, error: ATTENDEE_STATUS_UNSUPPORTED };
    }
    if (typeof item.email !== 'string' || item.email.trim() === '') {
      return { ok: false, error: 'Invalid input: each attendee must have a non-empty email' };
    }
    if (item.name !== undefined && typeof item.name !== 'string') {
      return { ok: false, error: 'Invalid input: attendee name must be a string when provided' };
    }
    const attendee: CalendarAttendeeInput = { email: item.email.trim() };
    if (typeof item.name === 'string') attendee.name = item.name;
    attendees.push(attendee);
  }
  return { ok: true, attendees };
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** Compare requested guest emails to the provider response. Skips participants with no email (rooms/resources). */
export function collectGuestListMismatches(
  requested: CalendarAttendeeInput[],
  returned: Array<{ email?: string | null }>,
): { missing: string[]; extra: string[] } {
  const returnedEmails = returned
    .map((p) => normalizedEmail(p.email))
    .filter((email): email is string => email !== null);
  const returnedSet = new Set(returnedEmails);
  const requestedEmails = requested
    .map((a) => normalizedEmail(a.email))
    .filter((email): email is string => email !== null);
  const requestedSet = new Set(requestedEmails);

  const missing = requestedEmails.filter((email) => !returnedSet.has(email));
  const extra = returnedEmails.filter((email) => !requestedSet.has(email));
  return { missing, extra };
}

export function guestListMismatchWarnings(missing: string[], extra: string[]): string[] {
  const warnings: string[] = [];
  if (missing.length > 0) {
    warnings.push(
      `Provider response omitted ${missing.length} requested attendee(s). The write already applied; do not retry. Re-read the event.`,
    );
  }
  if (extra.length > 0) {
    warnings.push(
      `Provider response included ${extra.length} extra participant(s) that were not requested (often the organizer). The write already applied; do not retry. Re-read the event.`,
    );
  }
  return warnings;
}
