import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { summarise, type HistorySummary, type SummariseInput } from '../../../../src/onboarding/deep-dive/history-summary.js';
import type { NylasMessageFull, NylasMessageSummary } from '../../../../src/channels/email/ceo-nylas-client.js';
import type { NylasCalendarEvent } from '../../../../src/channels/calendar/nylas-calendar-client.js';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/deep-dive');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

const mail = load<NylasMessageSummary[]>('mail.json');
const sentBodies = load<NylasMessageFull[]>('sent-bodies.json');
const calendar = load<NylasCalendarEvent[]>('calendar.json');

const TO = new Date('2026-11-23T12:00:00.000Z');
const FROM = new Date(TO.getTime() - 90 * 86_400_000);
const COVERAGE: HistorySummary['coverage'] = { messagesRead: 16, eventsRead: 16, requests: 40, rateLimited: 1, truncated: false };

function input(overrides: Partial<SummariseInput> = {}): SummariseInput {
  return {
    messages: mail,
    sentBodies,
    events: calendar,
    principalAddresses: ['CEO@acme.example.com'],
    window: { from: FROM, to: TO },
    coverage: COVERAGE,
    timezone: 'America/Toronto',
    ...overrides,
  };
}

const byEmail = (s: HistorySummary, email: string) => s.correspondents.find((c) => c.email === email);

describe('summarise', () => {
  it('counts two-way correspondents and reply latency', () => {
    const s = summarise(input());
    expect(byEmail(s, 'alice.smith@partner.example.com')).toMatchObject({
      name: 'Alice Smith', domain: 'partner.example.com', kind: 'person',
      received: 2, sent: 2, twoWay: true, medianReplyMinutes: 60,
    });
    // Sorted by volume, ties by address.
    expect(s.correspondents.map((c) => c.email)).toEqual([
      'alice.smith@partner.example.com',
      'bob.jones@vendor.example.net',
      'frank.moss@client.example.org',
      'noreply@saas.example.net',
      'carol.white@partner.example.com',
      'dave.lee@lawfirm.example.org',
      'erin.park@client.example.org',
      'info@vendor.example.net',
    ]);
  });

  it('marks one-way and automated senders', () => {
    const s = summarise(input());
    expect(byEmail(s, 'bob.jones@vendor.example.net')).toMatchObject({ received: 2, sent: 0, twoWay: false, medianReplyMinutes: null });
    // One message each way is below TWO_WAY_MIN_MESSAGES (3): still one-way, latency still measured.
    expect(byEmail(s, 'frank.moss@client.example.org')).toMatchObject({ received: 1, sent: 1, twoWay: false, medianReplyMinutes: 120 });
    expect(byEmail(s, 'carol.white@partner.example.com')).toMatchObject({ received: 0, sent: 1, twoWay: false });
    expect(byEmail(s, 'noreply@saas.example.net')).toMatchObject({ kind: 'automated', twoWay: false });
    expect(byEmail(s, 'info@vendor.example.net')).toMatchObject({ kind: 'organization', name: null });
    expect(s.unopened).toEqual([
      { fromDomain: 'saas.example.net', count: 2, evidence: { messageIds: ['m07', 'm06'] } },
      // m16 is unread but only 3 days old: not unopened yet.
      { fromDomain: 'vendor.example.net', count: 1, evidence: { messageIds: ['m05'] } },
    ]);
    expect(s.handedOff).toEqual([{ threadId: 't-contract', to: 'dave.lee@lawfirm.example.org', evidence: { messageIds: ['m09'] } }]);
  });

  it("excludes the principal's own addresses", () => {
    const s = summarise(input());
    const emails = s.correspondents.map((c) => c.email);
    // Self-sent (m10), CC to self (m04, m12) and the alias seen as a Sent-folder sender (m11, m12).
    expect(emails).not.toContain('ceo@acme.example.com');
    expect(emails).not.toContain('principal@example.com');
    expect(s.principalAddresses).toEqual(['ceo@acme.example.com', 'principal@example.com']);
    // The alias's sent mail still counts as the principal's.
    expect(byEmail(s, 'erin.park@client.example.org')).toMatchObject({ sent: 1, received: 0 });
    expect(s.recurringMeetings[0]!.attendees).toEqual(['alice.smith@partner.example.com']);
    expect(s.timeSpent.map((t) => t.key)).not.toContain('ceo@acme.example.com');
  });

  it('finds a weekly recurring meeting with 12 occurrences', () => {
    const s = summarise(input());
    expect(s.recurringMeetings).toHaveLength(1);
    expect(s.recurringMeetings[0]).toMatchObject({
      title: 'Leadership sync', seriesId: 'ser-1', cadence: 'weekly', minutesPerOccurrence: 60,
    });
    expect(s.recurringMeetings[0]!.evidence.eventIds).toHaveLength(10);
    // The moved occurrence (ev-ls-05) and the declined pitch.
    expect(s.meetingShape.declinedOrMoved).toBe(2);
    expect(s.meetingShape.medianMinutes).toBe(60);
  });

  it('finds a kept-clear Friday-afternoon block', () => {
    const zone = 'America/Toronto';
    const events: NylasCalendarEvent[] = [];
    const first = DateTime.fromISO('2026-11-02T00:00', { zone }); // a Monday
    for (let day = 0; day < 28; day++) {
      const d = first.plus({ days: day });
      if (d.weekday > 5) continue;
      const end = d.weekday === 5 ? d.set({ hour: 12 }) : d.set({ hour: 18 });
      events.push({
        id: `busy-${day}`, title: 'Busy', description: '', location: '',
        startTime: d.set({ hour: 8 }).toSeconds(), endTime: end.toSeconds(), startDate: null, endDate: null,
        participants: [{ email: 'ceo@acme.example.com', name: 'Avery', status: 'yes' }], conferencing: null,
        status: 'confirmed', calendarId: 'primary', busy: true, metadata: null,
      });
    }
    const s = summarise(input({
      messages: [], sentBodies: [], events,
      window: { from: first.toJSDate(), to: first.plus({ days: 28 }).toJSDate() },
      timezone: zone,
    }));
    expect(s.meetingShape.keptClearBlocks).toEqual([{ weekday: 5, start: '12:00', end: '18:00' }]);
  });

  it('groups time spent by organisation', () => {
    const s = summarise(input());
    const org = (key: string) => s.timeSpent.find((t) => t.by === 'organization' && t.key === key);
    expect(org('partner.example.com')).toEqual({ by: 'organization', key: 'partner.example.com', calendarHours: 13, messages: 5 });
    expect(org('vendor.example.net')).toEqual({ by: 'organization', key: 'vendor.example.net', calendarHours: 2, messages: 3 });
    // Declined events are not time spent.
    expect(org('client.example.org')).toEqual({ by: 'organization', key: 'client.example.org', calendarHours: 0, messages: 3 });
    expect(s.timeSpent.find((t) => t.by === 'series')).toEqual({ by: 'series', key: 'ser-1', calendarHours: 12, messages: 0 });
    expect(s.timeSpent.find((t) => t.by === 'person' && t.key === 'alice.smith@partner.example.com'))
      .toEqual({ by: 'person', key: 'alice.smith@partner.example.com', calendarHours: 12, messages: 4 });
    expect(s.timeSpent.some((t) => t.key === 'saas.example.net' || t.key === 'noreply@saas.example.net')).toBe(false);
  });

  it('every item carries evidence ids', () => {
    const s = summarise(input());
    const items = [
      ...s.correspondents.map((c) => c.evidence.messageIds),
      ...s.unopened.map((u) => u.evidence.messageIds),
      ...s.handedOff.map((h) => h.evidence.messageIds),
      ...s.recurringMeetings.map((r) => r.evidence.eventIds),
      s.meetingShape.evidence.eventIds,
    ];
    expect(items.length).toBeGreaterThan(10);
    for (const ids of items) {
      expect(ids!.length).toBeGreaterThan(0);
      expect(ids!.length).toBeLessThanOrEqual(10);
    }
    expect(s.meetingShape.evidence.eventIds!.slice(0, 2)).toEqual(['ev-declined', 'ev-ls-05']);
  });

  it('builds the voice sample from distinct recipients first, HTML and quotes stripped', () => {
    const s = summarise(input());
    expect(s.voiceSample.map((v) => v.messageId)).toEqual(['m14', 'm12', 'm08', 'm04', 'm02']);
    const m02 = s.voiceSample.find((v) => v.messageId === 'm02')!;
    expect(m02).toMatchObject({ to: 'alice.smith@partner.example.com', subject: 'Re: t-alice' });
    expect(m02.body).toBe('Works for me, Alice.\nThursday it is.');
    expect(s.voiceSample.find((v) => v.messageId === 'm12')!.body).toBe('Thanks Erin, looping in my work address.');
  });

  it('summarises a near-empty mailbox', () => {
    const coverage = { messagesRead: 3, eventsRead: 0, requests: 3, rateLimited: 0, truncated: false };
    const three = mail.filter((m) => ['m06', 'm07', 'm16'].includes(m.id));
    const s = summarise(input({ messages: three, sentBodies: [], events: [], coverage }));
    expect(s.coverage).toEqual(coverage);
    expect(s.window).toEqual({ from: FROM.toISOString(), to: TO.toISOString() });
    expect(s.correspondents.every((c) => !c.twoWay)).toBe(true);
    expect(s.correspondents).toHaveLength(2);
    expect(s.handedOff).toEqual([]);
    expect(s.recurringMeetings).toEqual([]);
    expect(s.timeSpent).toEqual([
      { by: 'person', key: 'bob.jones@vendor.example.net', calendarHours: 0, messages: 1 },
      { by: 'organization', key: 'vendor.example.net', calendarHours: 0, messages: 1 },
    ]);
    expect(s.voiceSample).toEqual([]);
    expect(s.meetingShape).toEqual({ medianMinutes: 0, bufferMinutesMedian: 0, keptClearBlocks: [], declinedOrMoved: 0, evidence: {} });
  });

  it('refuses an unusable timezone rather than silently finding no kept-clear blocks', () => {
    expect(() => summarise(input({ timezone: 'Eastern Time - Toronto' }))).toThrow(/timezone/);
  });

  it('is deterministic', () => {
    const a = summarise(input());
    const b = summarise(input());
    const reversed = summarise(input({
      messages: [...mail].reverse(), sentBodies: [...sentBodies].reverse(), events: [...calendar].reverse(),
    }));
    expect(b).toEqual(a);
    expect(reversed).toEqual(a);
    expect(a.generatedAt).toBe(TO.toISOString());
  });
});
