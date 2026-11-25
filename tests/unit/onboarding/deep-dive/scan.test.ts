import { NylasSdkTimeoutError } from 'nylas';
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
  /** The listing of this folder ('' = received) returns its first page, then ends on this error kind. */
  endsOn?: { folder: string; kind: 'rate_limited' | 'server_error' | 'network' };
}) {
  const listCalls: ListOpts[] = [];
  const getCalls: string[] = [];
  const client = {
    listAllMessages: vi.fn(async (o: ListOpts = {}) => {
      listCalls.push(o);
      if (opts.listError !== undefined) throw opts.listError;
      const src = opts.pages(o.folder ?? '');
      if (opts.endsOn && opts.endsOn.folder === (o.folder ?? '') && src !== 'endless') {
        o.onPage?.({ requests: 1, rateLimited: false });
        return { messages: src[0] ?? [], truncated: true, endedOn: opts.endsOn.kind };
      }
      const out: NylasMessageSummary[] = [];
      const maxScan = o.maxScan ?? 500;
      for (let i = 0; ; i++) {
        const page = src === 'endless'
          ? Array.from({ length: opts.pageSize ?? 20 }, (_, k) => message(`${o.folder}-${i}-${k}`, o.folder ?? '', 'ceo@acme.example.com', `p${i}-${k}@ext.example.com`))
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
      return { ...message(id, 'SENT', 'ceo@acme.example.com', 'a@b.example.com'), bcc: [], body: '<p>hello</p>', labels: [] };
    }),
  };
  return { client: client as unknown as CeoNylasClient, listCalls, getCalls };
}

/** The Nylas SDK's error shape: `statusCode`, read by nylasStatus. */
function sdkError(statusCode: number): Error {
  return Object.assign(new Error(`nylas ${statusCode}`), { statusCode });
}

type ListEventsOpts = { expandRecurring?: boolean; onIncomplete?: () => void; beforePage?: (page: number) => void | Promise<void> };

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
      // Like the real client: one beforePage per 200-event page, the first before anything is read.
      await o?.beforePage?.(0);
      const out = opts.listEvents ? await opts.listEvents(calls.length, o ?? {}) : calls.length === 1 ? events : [];
      for (let p = 1; p < Math.ceil(out.length / 200); p++) await o?.beforePage?.(p);
      return out;
    }),
  };
  return { client: client as unknown as NylasCalendarClient, calls };
}

function calEvent(id: string): NylasCalendarEvent {
  return {
    id, title: 'x', description: '', location: '', startTime: 1, endTime: 2, startDate: null, endDate: null,
    participants: [], conferencing: null, status: 'confirmed', calendarId: 'primary-cal', busy: true, metadata: null,
  };
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
    const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

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
    const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

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
      pages: (folder) => (folder === 'SENT' ? [[message('s1', 'SENT', 'alias@two.example.com', 'pat@ext.example.com')]] : []),
    });
    const d = deps(
      [view('mb-1', 'one@acme.example.com'), view('mb-2', 'Two@Acme.example.com'), view('mb-3', 'three@acme.example.com')],
      { 'mb-1': one.client, 'mb-2': two.client, 'mb-3': one.client },
      { 'mb-1': fakeCalendar().client, 'mb-2': fakeCalendar().client, 'mb-3': fakeCalendar().client },
    );

    const result = await scanHistory(d, ['mb-2']);

    expect(d.ceoClient.mock.calls.map((c) => c[0])).toEqual(['mb-2']);
    expect(d.calendarClient.mock.calls.map((c) => c[0])).toEqual(['mb-2']);
    expect(one.listCalls).toEqual([]);
    expect(result.principalAddresses).toEqual(['alias@two.example.com', 'two@acme.example.com']);
  });

  it('ends the scan as truncated, not failed, when a listing exhausts its 429 retries', async () => {
    const mail = fakeMail({ pages: () => [], listError: new NylasApiError(429, 'listAllMessages', 'rate limited') });
    const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar([calEvent('e1')]).client });

    const result = await scanHistory(d, ['mb-1']);

    // Each listing step ends on its own; the inbox is still tried after Sent gave up.
    expect(result.coverage.truncated).toBe(true);
    expect(mail.listCalls.map((c) => c?.folder)).toEqual(['SENT', undefined]);
  });

  describe('transient Nylas failures', () => {
    it('keeps the pages read before a late failure and marks the step truncated', async () => {
      const mail = fakeMail({
        pages: (folder) => (folder === 'SENT' ? [] : [[message('r1', 'INBOX', 'pat@ext.example.com', 'ceo@acme.example.com')]]),
        endsOn: { folder: '', kind: 'server_error' },
      });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

      const result = await scanHistory(d, ['mb-1']);

      expect(result.messages.map((m) => m.id)).toEqual(['r1']);
      expect(result.coverage).toMatchObject({ truncated: true, errors: 1, messagesRead: 1 });
    });

    it.each([
      ['a 5xx', new NylasApiError(502, 'listAllMessages', 'bad gateway')],
      ['a failed fetch', new NylasApiError(0, 'listAllMessages', 'fetch failed')],
    ])('a step failing on its first request with %s is truncated, not fatal', async (_n, err) => {
      const mail = fakeMail({ pages: () => [], listError: err });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar([calEvent('e1')]).client });

      const result = await scanHistory(d, ['mb-1']);

      expect(mail.listCalls.map((c) => c?.folder)).toEqual(['SENT', undefined]);
      expect(result.events.map((e) => e.id)).toEqual(['e1']);
      expect(result.coverage).toMatchObject({ truncated: true, errors: 2 });
    });

    it('a total outage (nothing read, steps failed) throws', async () => {
      const mail = fakeMail({ pages: () => [], listError: new NylasApiError(503, 'listAllMessages', 'unavailable') });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

      await expect(scanHistory(d, ['mb-1'])).rejects.toThrow(/read nothing/);
    });

    it('an empty mailbox with no errors succeeds', async () => {
      const mail = fakeMail({ pages: () => [] });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

      const result = await scanHistory(d, ['mb-1']);

      expect(result.coverage).toMatchObject({ messagesRead: 0, eventsRead: 0, errors: 0, truncated: false });
    });
  });

  describe('received mail', () => {
    it('lists every folder, keeps archived mail and drops spam, trash and drafts', async () => {
      const archived = message('arch', 'IMPORTANT', 'pat@ext.example.com', 'ceo@acme.example.com');
      const received = [
        archived,
        message('inb', 'INBOX', 'sam@ext.example.com', 'ceo@acme.example.com'),
        message('spam', 'SPAM', 'x@ext.example.com', 'ceo@acme.example.com'),
        message('trash', 'TRASH', 'y@ext.example.com', 'ceo@acme.example.com'),
        message('draft', 'DRAFT', 'ceo@acme.example.com', 'z@ext.example.com'),
        message('sent-late', 'SENT', 'ceo@acme.example.com', 'w@ext.example.com'),
      ];
      const mail = fakeMail({ pages: (folder) => (folder === 'SENT' ? [] : [received]) });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

      const result = await scanHistory(d, ['mb-1']);

      expect(mail.listCalls[1]).not.toHaveProperty('folder');
      expect(result.messages.map((m) => m.id)).toEqual(['arch', 'inb']);
    });
  });

  it('propagates an auth failure', async () => {
    const mail = fakeMail({ pages: () => [], listError: new NylasApiError(401, 'listAllMessages', 'unauthorized') });
    const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

    await expect(scanHistory(d, ['mb-1'])).rejects.toMatchObject({ status: 401 });
  });

  describe('calendar and voice failure paths', () => {
    const event = (id: string): NylasCalendarEvent => ({
      id, title: 'x', description: '', location: '', startTime: 1, endTime: 2, startDate: null, endDate: null,
      participants: [], conferencing: null, status: 'confirmed', calendarId: 'primary-cal', busy: true, metadata: null,
    });
    const sentPage = [[message('s1', 'SENT', 'ceo@acme.example.com', 'pat@ext.example.com'), message('s2', 'SENT', 'ceo@acme.example.com', 'sam@ext.example.com')]];

    it('a calendar 429 storm ends the calendar step only: Sent and received mail are still read', async () => {
      const mail = fakeMail({ pages: (folder) => (folder === 'SENT' ? sentPage : [[message('i1', 'INBOX', 'pat@ext.example.com', 'ceo@acme.example.com')]]) });
      // Window 1 succeeds; window 2 is rate-limited on the call and on its one retry.
      const cal = fakeCalendar([], {
        listEvents: async (n) => {
          if (n === 1) return [event('e1')];
          throw sdkError(429);
        },
      });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      const result = await scanHistory(d, ['mb-1']);

      expect(cal.calls).toHaveLength(3); // window 1, window 2, window 2 retried — then the step ends
      expect(result.events.map((e) => e.id)).toEqual(['e1']); // read before the storm, kept
      expect(mail.listCalls.map((c) => c?.folder)).toEqual(['SENT', undefined]);
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
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      const result = await scanHistory(d, ['mb-1']);

      expect(cal.calls).toHaveLength(14); // 13 windows + the one retry
      expect(result.coverage).toMatchObject({ truncated: false, rateLimited: 1 });
    });

    it('treats an SDK timeout as transient: retried once, then only the calendar step ends', async () => {
      const mail = fakeMail({ pages: (folder) => (folder === 'SENT' ? sentPage : []) });
      const cal = fakeCalendar([], {
        listEvents: async (n) => {
          if (n === 1) return [event('e1')];
          throw new NylasSdkTimeoutError('https://api.example.com/v3/grants/g/events', 90_000);
        },
      });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      const result = await scanHistory(d, ['mb-1']);

      expect(cal.calls).toHaveLength(3);
      expect(mail.listCalls.map((c) => c?.folder)).toEqual(['SENT', undefined]);
      expect(result.coverage).toMatchObject({ truncated: true, errors: 1 });
    });

    it('caps the calendar retry pause and paces every call after the first', async () => {
      const mail = fakeMail({ pages: (folder) => (folder === 'SENT' ? sentPage : []) });
      const retried = new Set<number>();
      // Every window is rate-limited once, then succeeds on its retry.
      let window = 0;
      const cal = fakeCalendar([], {
        listEvents: async () => {
          if (!retried.has(window)) {
            retried.add(window);
            throw sdkError(429);
          }
          window++;
          return [];
        },
      });
      const sleeps: number[] = [];
      const d = { ...deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client }), sleep: async (ms: number) => { sleeps.push(ms); } };

      const result = await scanHistory(d, ['mb-1']);

      expect(result.coverage).toMatchObject({ truncated: false, rateLimited: 13 });
      expect(Math.max(...sleeps)).toBe(30_000);
      // listCalendars, 13 windows, Sent, 2 bodies, received: 18 calls, 17 paced; plus 13 retry pauses.
      expect(sleeps.filter((ms) => ms === 1000)).toHaveLength(17);
      expect(sleeps).toHaveLength(17 + 13);
    });

    it('propagates a calendar auth failure', async () => {
      const mail = fakeMail({ pages: () => [] });
      const cal = fakeCalendar([], { listEvents: async () => { throw sdkError(401); } });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      await expect(scanHistory(d, ['mb-1'])).rejects.toMatchObject({ statusCode: 401 });
      expect(mail.listCalls).toEqual([]);
    });

    it('skips a mailbox with no primary calendar and still reads its mail', async () => {
      const mail = fakeMail({ pages: (folder) => (folder === 'SENT' ? sentPage : []) });
      const cal = fakeCalendar([], { noPrimary: true });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      const result = await scanHistory(d, ['mb-1']);

      expect(cal.calls).toEqual([]);
      expect(mail.listCalls.map((c) => c?.folder)).toEqual(['SENT', undefined]);
      expect(result.events).toEqual([]);
      expect(result.messages).toHaveLength(2);
      // An unread calendar is not complete coverage.
      expect(result.coverage.truncated).toBe(true);
    });

    it('counts and paces every page a calendar window takes, not one per window', async () => {
      const mail = fakeMail({ pages: () => [] });
      // Window 1 pages through 25 empty pages (the client's page cap) and returns nothing.
      const cal = fakeCalendar([], {
        listEvents: async (n, o) => {
          if (n === 1) for (let p = 1; p < 25; p++) await o.beforePage?.(p);
          return [];
        },
      });
      const sleeps: number[] = [];
      const d = { ...deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client }), sleep: async (ms: number) => { sleeps.push(ms); } };

      const result = await scanHistory(d, ['mb-1']);

      // listCalendars + 25 pages + 12 one-page windows + 2 mail folders.
      expect(result.coverage.requests).toBe(1 + 25 + 12 + 2);
      // 15 calls paced by the scan, plus the window's 24 later pages.
      expect(sleeps.filter((ms) => ms === 1000)).toHaveLength(15 + 24);
    });

    it('marks truncated when a calendar window reports an incomplete listing', async () => {
      const mail = fakeMail({ pages: () => [] });
      const cal = fakeCalendar([], {
        listEvents: async (n, o) => {
          if (n === 4) o.onIncomplete?.();
          return [];
        },
      });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      const result = await scanHistory(d, ['mb-1']);

      expect(cal.calls).toHaveLength(13); // the listing goes on; the window is just partial
      expect(result.coverage.truncated).toBe(true);
    });

    it('marks truncated when a calendar window hits the listing limit', async () => {
      const mail = fakeMail({ pages: () => [] });
      const full = Array.from({ length: 1000 }, (_, i) => event(`full-${i}`));
      const cal = fakeCalendar([], { listEvents: async (n) => (n === 1 ? full : []) });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': cal.client });

      const result = await scanHistory(d, ['mb-1']);

      expect(result.coverage.truncated).toBe(true);
      expect(result.coverage.eventsRead).toBe(1000);
      // 1 listCalendars + 5 pages for the full window + 12 empty windows + 2 mail folders.
      expect(result.coverage.requests).toBe(20);
    });

    it('a voice-body 429 ends the voice step only: received mail is still read', async () => {
      const mail = fakeMail({
        pages: (folder) => (folder === 'SENT' ? sentPage : [[message('i1', 'INBOX', 'pat@ext.example.com', 'ceo@acme.example.com')]]),
        getError: new NylasApiError(429, 'getMessage', 'rate limited'),
      });
      const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

      const result = await scanHistory(d, ['mb-1']);

      expect(mail.getCalls).toEqual(['s1']); // newest first; the step stops at the first 429
      expect(result.sentBodies).toEqual([]);
      expect(mail.listCalls.map((c) => c?.folder)).toEqual(['SENT', undefined]);
      expect(result.messages.map((m) => m.id)).toContain('i1');
      expect(result.coverage.truncated).toBe(true);
    });
  });

  it('marks coverage truncated when a requested mailbox is no longer connected', async () => {
    const mail = fakeMail({ pages: () => [] });
    const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

    const result = await scanHistory(d, ['mb-1', 'mb-gone']);

    expect(mail.listCalls).toHaveLength(2); // the connected mailbox is still read
    expect(result.coverage.truncated).toBe(true);
  });

  it('counts a message in both Inbox and Sent once', async () => {
    const self = message('self-1', 'SENT', 'ceo@acme.example.com', 'ceo@acme.example.com');
    const mail = fakeMail({ pages: () => [[self]] });
    const d = deps([view('mb-1', 'ceo@acme.example.com')], { 'mb-1': mail.client }, { 'mb-1': fakeCalendar().client });

    const result = await scanHistory(d, ['mb-1']);

    expect(result.messages.map((m) => m.id)).toEqual(['self-1']);
    expect(result.coverage.messagesRead).toBe(1);
  });
});
