import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { scanHistory, type ScanDeps } from '../../../../src/onboarding/deep-dive/scan.js';
import { MAX_REQUESTS, VOICE_SAMPLE_SIZE } from '../../../../src/onboarding/deep-dive/limits.js';
import {
  NylasApiError,
  type CeoNylasClient,
  type NylasMessageFull,
  type NylasMessageSummary,
} from '../../../../src/channels/email/ceo-nylas-client.js';
import type { NylasCalendarClient, NylasCalendarEvent } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import type { PrincipalMailboxView } from '../../../../src/principal-mailboxes/service.js';

const logger = pino({ level: 'silent' });
const NOW = new Date('2026-11-23T12:00:00.000Z');

type ListOpts = Parameters<CeoNylasClient['listAllMessages']>[0];

function message(id: string, folder: string, from: string, to: string): NylasMessageSummary {
  return {
    id, threadId: `t-${id}`, subject: 'hi', from: [{ email: from }], to: [{ email: to }], cc: [],
    snippet: '', date: Math.floor(NOW.getTime() / 1000) - 3600, unread: false, folders: [folder], attachments: [],
  };
}

/** A fake mailbox: `pages(folder)` yields pages; each page reports `requestsPerPage` requests. */
function fakeMail(opts: {
  pages: (folder: string) => NylasMessageSummary[][] | 'endless';
  requestsPerPage?: number;
  pageSize?: number;
  listError?: unknown;
  getError?: unknown;
}) {
  const listCalls: ListOpts[] = [];
  const getCalls: string[] = [];
  const client = {
    listAllMessages: vi.fn(async (o: ListOpts = {}) => {
      listCalls.push(o);
      if (opts.listError !== undefined) throw opts.listError;
      const src = opts.pages(o.folder ?? '');
      const out: NylasMessageSummary[] = [];
      const maxScan = o.maxScan ?? 500;
      for (let i = 0; ; i++) {
        const page = src === 'endless'
          ? Array.from({ length: opts.pageSize ?? 20 }, (_, k) => message(`${o.folder}-${i}-${k}`, o.folder ?? '', 'ceo@acme.com', `p${i}-${k}@ext.com`))
          : src[i] ?? (i === 0 ? [] : undefined); // an empty folder is one empty page
        if (!page) return { messages: out, truncated: false };
        out.push(...page);
        const more = src === 'endless' || i + 1 < src.length;
        const keepGoing = o.onPage?.({ requests: opts.requestsPerPage ?? 1, rateLimited: false });
        if (keepGoing === false || out.length >= maxScan) return { messages: out.slice(0, maxScan), truncated: more };
      }
    }),
    getMessage: vi.fn(async (id: string): Promise<NylasMessageFull> => {
      getCalls.push(id);
      if (opts.getError !== undefined) throw opts.getError;
      return { ...message(id, 'SENT', 'ceo@acme.com', 'a@b.com'), bcc: [], body: '<p>hello</p>', labels: [] };
    }),
  };
  return { client: client as unknown as CeoNylasClient, listCalls, getCalls };
}

/** The Nylas SDK's error shape: `statusCode`, read by nylasStatus. */
function sdkError(statusCode: number): Error {
  return Object.assign(new Error(`nylas ${statusCode}`), { statusCode });
}

type ListEventsOpts = { expandRecurring?: boolean; onIncomplete?: () => void };

function fakeCalendar(
  events: NylasCalendarEvent[] = [],
  opts: {
    /** Replaces the default listing (first call returns `events`, later ones none); `n` counts from 1. */
    listEvents?: (n: number, o: ListEventsOpts) => Promise<NylasCalendarEvent[]>;
    noPrimary?: boolean;
  } = {},
) {
  const calls: Array<{ calendarId: string; timeMin: string; timeMax: string; opts: unknown }> = [];
  const client = {
    listCalendars: vi.fn(async () => [
      { id: 'other', name: 'Other', description: '', timezone: 'UTC', isPrimary: false, readOnly: false, isOwnedByUser: true },
      { id: 'primary-cal', name: 'Me', description: '', timezone: 'UTC', isPrimary: !opts.noPrimary, readOnly: false, isOwnedByUser: true },
    ]),
    listEvents: vi.fn(async (calendarId: string, timeMin: string, timeMax: string, o?: ListEventsOpts) => {
      calls.push({ calendarId, timeMin, timeMax, opts: o });
      if (opts.listEvents) return opts.listEvents(calls.length, o ?? {});
      return calls.length === 1 ? events : [];
    }),
  };
  return { client: client as unknown as NylasCalendarClient, calls };
}

function view(id: string, address: string): PrincipalMailboxView {
  return { id, label: id, address, isDefault: false, triageStartAt: null };
}

function deps(
  views: PrincipalMailboxView[],
  mail: Record<string, CeoNylasClient>,
  cal: Record<string, NylasCalendarClient>,
): ScanDeps & { ceoClient: ReturnType<typeof vi.fn>; calendarClient: ReturnType<typeof vi.fn> } {
  const ceoClient = vi.fn(async (id: string) => mail[id]!);
  const calendarClient = vi.fn(async (id: string) => cal[id]!);
  return {
    mailboxes: { list: async () => views, ceoClient, calendarClient },
    logger,
    now: NOW,
    sleep: async () => {},
    ceoClient,
    calendarClient,
  };
}

describe('scanHistory', () => {
  it('stops at MAX_REQUESTS and marks truncated', async () => {
    // Partial pages (5 messages) so the request cap, not the message cap, is what ends the scan.
    const mail = fakeMail({ pages: () => 'endless', pageSize: 5 });
    const cal = fakeCalendar();
    const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

    const result = await scanHistory(d, ['mb-1']);

    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.requests).toBe(MAX_REQUESTS);
    // Sent is read first and leaves room for the voice bodies; the inbox never starts.
    expect(mail.listCalls.map((c) => c?.folder)).toEqual(['SENT']);
    expect(mail.getCalls).toHaveLength(VOICE_SAMPLE_SIZE);
    expect(result.coverage.messagesRead).toBe(result.messages.length);
    expect(result.sentBodies).toHaveLength(VOICE_SAMPLE_SIZE);
  });

  it('windows calendar listing in 7-day chunks across 90 days', async () => {
    const mail = fakeMail({ pages: () => [] });
    const event: NylasCalendarEvent = {
      id: 'e1', title: 'x', description: '', location: '', startTime: 1, endTime: 2, startDate: null, endDate: null,
      participants: [], conferencing: null, status: 'confirmed', calendarId: 'primary-cal', busy: true, metadata: null,
    };
    const cal = fakeCalendar([event]);
    const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

    const result = await scanHistory(d, ['mb-1']);

    expect(cal.calls).toHaveLength(13);
    expect(cal.calls.every((c) => c.calendarId === 'primary-cal')).toBe(true);
    expect(cal.calls.every((c) => (c.opts as { expandRecurring?: boolean }).expandRecurring === true)).toBe(true);
    expect(cal.calls[0]!.timeMin).toBe(new Date(NOW.getTime() - 90 * 86_400_000).toISOString());
    expect(cal.calls[12]!.timeMax).toBe(NOW.toISOString());
    for (let i = 1; i < cal.calls.length; i++) expect(cal.calls[i]!.timeMin).toBe(cal.calls[i - 1]!.timeMax);
    expect(result.events.map((e) => e.id)).toEqual(['e1']);
    expect(result.coverage).toMatchObject({ eventsRead: 1, truncated: false });
    // listCalendars + 13 listings; the two empty mail folders take one request each.
    expect(result.coverage.requests).toBe(16);
  });

  it('reads only the given mailbox ids', async () => {
    const one = fakeMail({ pages: () => [] });
    const two = fakeMail({
      pages: (folder) => (folder === 'SENT' ? [[message('s1', 'SENT', 'alias@two.com', 'pat@ext.com')]] : []),
    });
    const d = deps(
      [view('mb-1', 'one@acme.com'), view('mb-2', 'Two@Acme.com'), view('mb-3', 'three@acme.com')],
      { 'mb-1': one.client, 'mb-2': two.client, 'mb-3': one.client },
      { 'mb-1': fakeCalendar().client, 'mb-2': fakeCalendar().client, 'mb-3': fakeCalendar().client },
    );

    const result = await scanHistory(d, ['mb-2']);

    expect(d.ceoClient.mock.calls.map((c) => c[0])).toEqual(['mb-2']);
    expect(d.calendarClient.mock.calls.map((c) => c[0])).toEqual(['mb-2']);
    expect(one.listCalls).toEqual([]);
    expect(result.principalAddresses).toEqual(['alias@two.com', 'two@acme.com']);
  });

  it('ends the scan as truncated, not failed, when a listing exhausts its 429 retries', async () => {
    const mail = fakeMail({ pages: () => [], listError: new NylasApiError(429, 'listAllMessages', 'rate limited') });
    const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

    const result = await scanHistory(d, ['mb-1']);

    // Each listing step ends on its own; the inbox is still tried after Sent gave up.
    expect(result.coverage.truncated).toBe(true);
    expect(mail.listCalls.map((c) => c?.folder)).toEqual(['SENT', 'INBOX']);
  });

  it('propagates an auth failure', async () => {
    const mail = fakeMail({ pages: () => [], listError: new NylasApiError(401, 'listAllMessages', 'unauthorized') });
    const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

    await expect(scanHistory(d, ['mb-1'])).rejects.toMatchObject({ status: 401 });
  });

  describe('calendar and voice failure paths', () => {
    const event = (id: string): NylasCalendarEvent => ({
      id, title: 'x', description: '', location: '', startTime: 1, endTime: 2, startDate: null, endDate: null,
      participants: [], conferencing: null, status: 'confirmed', calendarId: 'primary-cal', busy: true, metadata: null,
    });
    const sentPage = [[message('s1', 'SENT', 'ceo@acme.com', 'pat@ext.com'), message('s2', 'SENT', 'ceo@acme.com', 'sam@ext.com')]];

    it('a calendar 429 storm ends the calendar step only: Sent and Inbox are still read', async () => {
      const mail = fakeMail({ pages: (folder) => (folder === 'SENT' ? sentPage : [[message('i1', 'INBOX', 'pat@ext.com', 'ceo@acme.com')]]) });
      // Window 1 succeeds; window 2 is rate-limited on the call and on its one retry.
      const cal = fakeCalendar([], {
        listEvents: async (n) => {
          if (n === 1) return [event('e1')];
          throw sdkError(429);
        },
      });
      const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      const result = await scanHistory(d, ['mb-1']);

      expect(cal.calls).toHaveLength(3); // window 1, window 2, window 2 retried — then the step ends
      expect(result.events.map((e) => e.id)).toEqual(['e1']); // read before the storm, kept
      expect(mail.listCalls.map((c) => c?.folder)).toEqual(['SENT', 'INBOX']);
      expect(result.messages.map((m) => m.id)).toEqual(['s1', 's2', 'i1']);
      expect(result.coverage).toMatchObject({ truncated: true, rateLimited: 1 });
    });

    it('retries a rate-limited calendar window once and carries on', async () => {
      const mail = fakeMail({ pages: () => [] });
      let failed = false;
      const cal = fakeCalendar([], {
        listEvents: async (n) => {
          if (n === 2 && !failed) {
            failed = true;
            throw sdkError(429);
          }
          return [];
        },
      });
      const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      const result = await scanHistory(d, ['mb-1']);

      expect(cal.calls).toHaveLength(14); // 13 windows + the one retry
      expect(result.coverage).toMatchObject({ truncated: false, rateLimited: 1 });
    });

    it('propagates a calendar auth failure', async () => {
      const mail = fakeMail({ pages: () => [] });
      const cal = fakeCalendar([], { listEvents: async () => { throw sdkError(401); } });
      const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      await expect(scanHistory(d, ['mb-1'])).rejects.toMatchObject({ statusCode: 401 });
      expect(mail.listCalls).toEqual([]);
    });

    it('skips a mailbox with no primary calendar and still reads its mail', async () => {
      const mail = fakeMail({ pages: (folder) => (folder === 'SENT' ? sentPage : []) });
      const cal = fakeCalendar([], { noPrimary: true });
      const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      const result = await scanHistory(d, ['mb-1']);

      expect(cal.calls).toEqual([]);
      expect(mail.listCalls.map((c) => c?.folder)).toEqual(['SENT', 'INBOX']);
      expect(result.events).toEqual([]);
      expect(result.messages).toHaveLength(2);
    });

    it('marks truncated when a calendar window reports an incomplete listing', async () => {
      const mail = fakeMail({ pages: () => [] });
      const cal = fakeCalendar([], {
        listEvents: async (n, o) => {
          if (n === 4) o.onIncomplete?.();
          return [];
        },
      });
      const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      const result = await scanHistory(d, ['mb-1']);

      expect(cal.calls).toHaveLength(13); // the listing goes on; the window is just partial
      expect(result.coverage.truncated).toBe(true);
    });

    it('marks truncated when a calendar window hits the listing limit', async () => {
      const mail = fakeMail({ pages: () => [] });
      const full = Array.from({ length: 1000 }, (_, i) => event(`full-${i}`));
      const cal = fakeCalendar([], { listEvents: async (n) => (n === 1 ? full : []) });
      const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      const result = await scanHistory(d, ['mb-1']);

      expect(result.coverage.truncated).toBe(true);
      expect(result.coverage.eventsRead).toBe(1000);
      // 1 listCalendars + 5 pages for the full window + 12 empty windows + 2 mail folders.
      expect(result.coverage.requests).toBe(20);
    });

    it('a voice-body 429 ends the voice step only: the inbox is still read', async () => {
      const mail = fakeMail({
        pages: (folder) => (folder === 'SENT' ? sentPage : [[message('i1', 'INBOX', 'pat@ext.com', 'ceo@acme.com')]]),
        getError: new NylasApiError(429, 'getMessage', 'rate limited'),
      });
      const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

      const result = await scanHistory(d, ['mb-1']);

      expect(mail.getCalls).toEqual(['s1']); // newest first; the step stops at the first 429
      expect(result.sentBodies).toEqual([]);
      expect(mail.listCalls.map((c) => c?.folder)).toEqual(['SENT', 'INBOX']);
      expect(result.messages.map((m) => m.id)).toContain('i1');
      expect(result.coverage.truncated).toBe(true);
    });
  });

  it('counts a message in both Inbox and Sent once', async () => {
    const self = message('self-1', 'SENT', 'ceo@acme.com', 'ceo@acme.com');
    const mail = fakeMail({ pages: () => [[self]] });
    const d = deps([view('mb-1', 'ceo@acme.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

    const result = await scanHistory(d, ['mb-1']);

    expect(result.messages.map((m) => m.id)).toEqual(['self-1']);
    expect(result.coverage.messagesRead).toBe(1);
  });
});
