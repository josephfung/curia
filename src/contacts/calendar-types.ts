// src/contacts/calendar-types.ts
//
// Types for the calendar registry — maps Nylas calendar IDs to contacts.
// A contact can have multiple calendars (work, personal, etc.).
// Org-wide calendars (holidays, rooms) have null contact_id.

export interface ContactCalendar {
  id: string;
  nylasCalendarId: string;
  contactId: string | null;
  label: string;
  isPrimary: boolean;
  readOnly: boolean;
  timezone: string | null;
  /** The principal mailbox this calendar belongs to; null for org-wide and other contacts' calendars. */
  principalMailboxId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCalendarLinkOptions {
  nylasCalendarId: string;
  /** null for org-wide calendars (holidays, conference rooms) */
  contactId: string | null;
  label: string;
  isPrimary?: boolean;
  readOnly?: boolean;
  timezone?: string;
  /** The principal mailbox the calendar belongs to. Omitted/null: none. */
  principalMailboxId?: string | null;
}

/** Resolved registry entry for a Nylas calendar ID. Returned by resolveCalendar(). */
export interface ResolvedCalendar {
  contactId: string | null;
  label: string;
  isPrimary: boolean;
  readOnly: boolean;
  principalMailboxId: string | null;
}
