// Test fixture for the calendar tools (#2475): a real CalendarRouter over stub mailboxes, so
// handler tests exercise the routing code. Imported by tests only.

import type { ToolContext } from '../../src/skills/types.js';
import { CalendarRouter } from '../../src/channels/calendar/calendar-router.js';
import type { NylasCalendarClient } from '../../src/channels/calendar/nylas-calendar-client.js';
import type { ContactCalendar, ResolvedCalendar } from '../../src/contacts/calendar-types.js';
import type { PrincipalMailboxView } from '../../src/principal-mailboxes/service.js';
import type { MailboxEvidence } from '../../src/principal-mailboxes/evidence.js';
import { RemovedMailboxError, UnknownMailboxError } from '../../src/principal-mailboxes/types.js';
import { createSilentLogger } from '../../src/logger.js';

export const TEST_PRINCIPAL_CONTACT_ID = '00000000-0000-4000-8000-0000000000aa';

const clients = new WeakMap<CalendarRouter, unknown>();

export function calendarMailbox(id: string, label: string, address: string, isDefault = false): PrincipalMailboxView {
  return { id, label, address, isDefault, triageStartAt: null };
}

export interface RouterFixture {
  /** Live mailboxes. Default: one default mailbox `work` at ceo@example.com. */
  mailboxes?: PrincipalMailboxView[];
  /** Removed mailboxes by id → label. */
  removed?: Record<string, string>;
  /** Calendar client per mailbox id. */
  clients: Record<string, unknown>;
  /** Registry rows by Nylas calendar id (what resolveCalendar answers). */
  registry?: Record<string, Partial<ResolvedCalendar> & { principalMailboxId: string | null }>;
  /** The principal's calendars (getCalendarsForContact / getPrimaryCalendar read these). */
  principalCalendars?: Array<Pick<ContactCalendar, 'nylasCalendarId' | 'isPrimary' | 'principalMailboxId'>>;
  fallbackActive?: boolean;
  /** A real registry to read instead of `registry` / `principalCalendars` (e.g. an in-memory ContactService). */
  contacts?: ConstructorParameters<typeof CalendarRouter>[0]['contacts'];
  principalContactId?: string;
  /** Mailbox evidence for attendees. Default: every live mailbox with no history. */
  evidence?: (recipients: string[]) => Promise<MailboxEvidence[]>;
}

/** An evidence row with no history, for fixtures. */
export function noEvidence(m: PrincipalMailboxView, extra: Partial<MailboxEvidence> = {}): MailboxEvidence {
  return { mailbox: m.id, mailbox_label: m.label, sent_count: 0, last_sent_at: null, recent_subjects: [], received_count: 0, domain_match: false, ...extra };
}

/** A real CalendarRouter over the fixture. */
export function routerFixture(f: RouterFixture): CalendarRouter {
  const mailboxes = f.mailboxes ?? [calendarMailbox('work', 'Work', 'ceo@example.com', true)];
  const principalCalendars = (f.principalCalendars ?? []).map((c, i) => ({
    id: `row-${i}`,
    contactId: TEST_PRINCIPAL_CONTACT_ID,
    label: c.nylasCalendarId,
    readOnly: false,
    timezone: null,
    createdAt: new Date(2026, 0, 1 + i),
    updatedAt: new Date(2026, 0, 1 + i),
    ...c,
  })) as ContactCalendar[];
  return new CalendarRouter({
    mailboxes: {
      list: async () => mailboxes,
      get: async (id: string) => {
        const removedLabel = f.removed?.[id];
        if (removedLabel !== undefined) throw new RemovedMailboxError(id, removedLabel);
        const m = mailboxes.find((x) => x.id === id);
        if (!m) throw new UnknownMailboxError(id);
        return m;
      },
      isFallbackActive: async () => f.fallbackActive ?? false,
      calendarClient: async (id: string) => {
        const c = f.clients[id];
        if (!c) throw new Error(`no stub calendar client for ${id}`);
        return c as NylasCalendarClient;
      },
      evidence: f.evidence ?? (async () => mailboxes.map((m) => noEvidence(m))),
    },
    contacts: f.contacts ?? {
      resolveCalendar: async (calId: string) => {
        const row = f.registry?.[calId];
        return row
          ? { contactId: null, label: calId, isPrimary: false, readOnly: false, ...row }
          : null;
      },
      getCalendarsForContact: async () => principalCalendars,
      getPrimaryCalendar: async (_contactId: string, mailboxId?: string) =>
        principalCalendars.find((c) => c.isPrimary && (mailboxId === undefined || c.principalMailboxId === mailboxId)) ?? null,
    },
    principalContactId: f.principalContactId ?? TEST_PRINCIPAL_CONTACT_ID,
    logger: createSilentLogger(),
  });
}

/**
 * The single-mailbox router the calendar tool tests use: one live mailbox (`work`), nothing
 * registered, every calendar routed to `client` — the behaviour of the old boot client.
 */
export function singleMailboxRouter(client: unknown): CalendarRouter {
  const router = routerFixture({ clients: { work: client } });
  clients.set(router, client);
  return router;
}

/** The stub client behind a ctx's single-mailbox router (for asserting on its mocks). */
export function calendarClientOf(ctx: Pick<ToolContext, 'calendarRouter'>): NylasCalendarClient {
  const router = ctx.calendarRouter;
  if (!router || !clients.has(router)) throw new Error('ctx has no single-mailbox test router');
  return clients.get(router) as NylasCalendarClient;
}
