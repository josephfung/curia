// Stubbed list/search results answer the question asked (#1956).
import { describe, expect, it } from 'vitest';
import { fillInputPlaceholders, matchesMailQuery, shapeStubResult } from '../../smoke/stub-filters.js';

const events = {
  displayTimezone: 'America/Toronto',
  events: [
    { id: 'a', title: 'Standup', startTime: '2026-10-07T08:30:00-04:00', endTime: '2026-10-07T09:00:00-04:00', participants: [] },
    { id: 'b', title: 'Partner call — Nexus', startTime: '2026-10-07T11:00:00-04:00', endTime: '2026-10-07T12:00:00-04:00', participants: [{ email: 'sarah.chen@nexus.example' }] },
    { id: 'c', title: 'All-hands', startTime: '2026-10-09T10:00:00-04:00', endTime: '2026-10-09T11:00:00-04:00', participants: [] },
  ],
};

describe('calendar-list-events', () => {
  it('keeps events overlapping the requested window and recounts', () => {
    const r = shapeStubResult('calendar-list-events', events, { timeMin: '2026-10-07T00:00:00-04:00', timeMax: '2026-10-08T00:00:00-04:00' }) as { events: Array<{ id: string }>; count: number };
    expect(r.events.map(e => e.id)).toEqual(['a', 'b']);
    expect(r.count).toBe(2);
  });

  it('filters by query and attendee', () => {
    expect((shapeStubResult('calendar-list-events', events, { query: 'nexus' }) as { events: unknown[] }).events).toHaveLength(1);
    expect((shapeStubResult('calendar-list-events', events, { attendeeEmail: 'Sarah.Chen@nexus.example' }) as { events: unknown[] }).events).toHaveLength(1);
  });
});

describe('calendar-find-free-time', () => {
  it('keeps windows inside the range that fit the duration', () => {
    const data = { freeWindows: [
      { start: '2026-10-05T11:00:00-04:00', end: '2026-10-05T11:30:00-04:00' },
      { start: '2026-10-05T15:00:00-04:00', end: '2026-10-05T17:00:00-04:00' },
      { start: '2026-10-09T12:00:00-04:00', end: '2026-10-09T14:00:00-04:00' },
    ] };
    const r = shapeStubResult('calendar-find-free-time', data, { timeMin: '2026-10-05T00:00:00-04:00', timeMax: '2026-10-06T00:00:00-04:00', duration: 45 }) as { freeWindows: Array<{ start: string }> };
    expect(r.freeWindows.map(w => w.start)).toEqual(['2026-10-05T15:00:00-04:00']);
  });
});

describe('mailbox', () => {
  const inbox = { messages: [
    { id: 'm1', from: [{ name: 'Priya Sharma', email: 'priya.sharma@curiatech.example' }], subject: 'Q2 board deck', snippet: 'Attached', unread: true },
    { id: 'm2', from: [{ name: 'Elena Ruiz', email: 'elena.ruiz@northstar.example' }], subject: 'Need to talk today', snippet: 'board matter', unread: false },
  ], count: 2 };

  it('matches from:, subject: and bare words, and ignores operators it cannot evaluate', () => {
    expect(matchesMailQuery(inbox.messages[0]!, 'from:priya has:attachment')).toBe(true);
    expect(matchesMailQuery(inbox.messages[0]!, 'subject:"board deck"')).toBe(true);
    expect(matchesMailQuery(inbox.messages[1]!, 'board is:unread')).toBe(true);
    expect(matchesMailQuery(inbox.messages[1]!, 'from:priya')).toBe(false);
  });

  it('search filters by query; list keeps unread unless asked otherwise', () => {
    expect((shapeStubResult('ceo-inbox-search', inbox, { query: 'from:elena' }) as { messages: Array<{ id: string }> }).messages.map(m => m.id)).toEqual(['m2']);
    expect((shapeStubResult('ceo-inbox-list', inbox, {}) as { messages: Array<{ id: string }> }).messages.map(m => m.id)).toEqual(['m1']);
    expect((shapeStubResult('ceo-inbox-list', inbox, { unread_only: false }) as { count: number }).count).toBe(2);
  });
});

describe('fillInputPlaceholders', () => {
  it('takes a whole-placeholder value as-is and embeds others as text', () => {
    expect(fillInputPlaceholders({ to: '{{input:to}}', subject: 'Re: {{input:subject}}', missing: '{{input:nope}}' }, { to: [{ email: 'a@b' }], subject: 'Hi' }))
      .toEqual({ to: [{ email: 'a@b' }], subject: 'Re: Hi', missing: null });
  });

  it('leaves tools without a filter unchanged apart from inputs', () => {
    expect(shapeStubResult('task-create', { title: '{{input:title}}', events: 'x' }, { title: 'Chase DD' })).toEqual({ title: 'Chase DD', events: 'x' });
  });
});
