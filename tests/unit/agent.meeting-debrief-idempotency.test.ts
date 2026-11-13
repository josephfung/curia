// tests/unit/agent.meeting-debrief-idempotency.test.ts
//
// Guards against regression of #724 (5 duplicate Bullpen prompts for the same
// meeting on 2026-05-26). Verifies that the meeting-debrief system prompt reads
// the prompted:<meetingKey> guard before Step 6 posts (the wake's phase derivation,
// #839, which replaced Step 6's own re-check in #2025), writes the key after a
// successful post, and handles write failures gracefully. The behavior is covered
// by scenario cases 32b and 32h.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import pino from 'pino';
import type { ToolContext } from '../../src/skills/types.js';
import type { NylasCalendarEvent } from '../../src/channels/calendar/nylas-calendar-client.js';
import { meetingKey } from '../../src/channels/calendar/event-identity.js';
import { CalendarListEventsHandler } from '../../skills/calendar/tools/calendar-list-events/handler.js';
import { calendarMailbox, routerFixture } from '../../skills/_shared/calendar-router-test-helpers.js';

let prompt: string;
let step6: string;
let wakeDerivation: string;

beforeAll(() => {
  const agentPath = path.resolve(import.meta.dirname, '../../agents/meeting-debrief.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(agentPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot load meeting-debrief.yaml from ${agentPath}: ${(err as Error).message}. ` +
      `Is the test running from the repo root?`,
    );
  }
  const parsed = yaml.load(raw) as Record<string, unknown>;
  if (typeof parsed.system_prompt !== 'string') {
    throw new Error('meeting-debrief.yaml is missing a system_prompt string field');
  }
  prompt = parsed.system_prompt;

  const start = prompt.indexOf('## Step 6');
  const end = prompt.indexOf('## Step 7');
  if (start === -1 || end === -1) {
    throw new Error('Step 6 or Step 7 heading not found in system_prompt — was a heading renamed?');
  }
  step6 = prompt.slice(start, end);
  const wakeStart = prompt.indexOf('# TASK WAKE-UP MODE');
  if (wakeStart === -1 || wakeStart > start) {
    throw new Error('TASK WAKE-UP MODE heading not found before Step 6 — was a heading renamed?');
  }
  wakeDerivation = prompt.slice(wakeStart, start);
  if (step6.length < 50) {
    throw new Error(`Step 6 section is suspiciously short (${step6.length} chars) — may have been truncated`);
  }
});

describe('meeting-debrief idempotency guard (issue #724)', () => {
  it('derives the phase from prompted:<eventId> before Step 6 opens a Bullpen thread', () => {
    // A wake reaches Step 6 (the post) only when prompted:<meetingKey> is absent; when it
    // is present the wake goes to Step 7 instead. If this fails, a resent wake can post
    // a duplicate prompt for the same calendar event.
    expect(wakeDerivation).toMatch(/`prompted:<meetingKey>` absent → \*\*Step 6\*\*/);
    expect(wakeDerivation).toMatch(/`prompted:` present[^\n]*→ \*\*Step 7\*\*/);
  });

  it('instructs the agent to write the idempotency key to config-store after the post, not before', () => {
    // The store must come AFTER the bullpen post — writing before would create a phantom
    // key that blocks all future posts if the bullpen call then fails.
    expect(step6).toMatch(/action.*['"']store['"']|store.*prompted:|prompted:.*store/i);
    const idxPost = step6.indexOf('`bullpen-post` with');
    const idxStore = step6.search(/action.*['"']store['"']/);
    expect(idxPost).toBeGreaterThan(-1);
    expect(idxStore).toBeGreaterThan(idxPost);
  });

  it('includes thread_id in the stored idempotency value', () => {
    // The stored value must include the thread_id so a future debug session can
    // trace which Bullpen thread was the canonical one.
    expect(step6).toMatch(/thread_id/);
  });

  it('instructs the agent to handle a failed config-store write without retrying the Bullpen post', () => {
    // If the idempotency key write fails, the agent must NOT retry the bullpen post.
    // Without this guard, a write failure defeats the entire duplicate-prevention mechanism.
    expect(step6).toMatch(/stored.*false|store.*fail|success.*false|not.*persist|key.*not.*persisted|may not.*persist/i);
    // Separately verify the no-retry instruction exists. A prompt that acknowledges write
    // failure but still retries defeats the guard; this catches that regression.
    expect(step6).toMatch(/do not retry|not retry|no.*retry/i);
  });
});

// #2475 (D7): the same meeting on two of the principal's calendars is debriefed once. The guards
// key on list-events' meetingKey, which is the same for every copy of a meeting (iCal UID and
// occurrence) and still tells a weekly series' instances apart.
describe('meeting-debrief keys its guards on the meeting, not one calendar copy (#2475)', () => {
  function evt(id: string, extra: Partial<NylasCalendarEvent> = {}): NylasCalendarEvent {
    return {
      id, title: 'Acme partnership review', description: '', location: '', startTime: 1_795_100_000, endTime: 1_795_103_600,
      startDate: null, endDate: null, participants: [], conferencing: null, status: 'confirmed', calendarId: 'x',
      busy: true, metadata: null, icalUid: 'acme-uid@google.com', ...extra,
    };
  }

  it('dedupes a meeting on both calendars by iCal UID', async () => {
    const work = { listEvents: vi.fn().mockResolvedValue([evt('work-copy')]) };
    const personal = { listEvents: vi.fn().mockResolvedValue([evt('personal-copy')]) };
    const router = routerFixture({
      mailboxes: [calendarMailbox('work', 'Work', 'ceo@work.example.com', true), calendarMailbox('personal', 'Personal', 'ceo@gmail.com')],
      clients: { work, personal },
      registry: { 'cal-work': { principalMailboxId: 'work' }, 'cal-personal': { principalMailboxId: 'personal' } },
    });
    const ctx = {
      toolName: 'calendar-list-events', toolVersion: '0.0.0', log: pino({ level: 'silent' }),
      secret: () => { throw new Error('no secrets'); },
      input: { contactId: '00000000-0000-4000-8000-0000000000aa', timeMin: '2026-11-20T00:00:00Z', timeMax: '2026-11-21T00:00:00Z' },
      taskMetadata: { originator: { systemRole: 'system' } },
      calendarRouter: router,
      contactService: { getCalendarsForContact: vi.fn().mockResolvedValue([{ nylasCalendarId: 'cal-work' }, { nylasCalendarId: 'cal-personal' }]) },
    } as unknown as ToolContext;
    const r = await new CalendarListEventsHandler().execute(ctx);
    expect(r, JSON.stringify(r)).toMatchObject({ success: true });
    const events = (r as { success: true; data: { events: Array<{ id: string; meetingKey: string }> } }).data.events;
    // One entry for both copies; its key is what either copy's key would be.
    expect(events).toHaveLength(1);
    expect(events[0]!.meetingKey).toBe(meetingKey(evt('personal-copy')));
    expect(events[0]!.meetingKey).not.toBe(events[0]!.id);
    // The guards use that key.
    expect(prompt).toMatch(/`seen:<meetingKey>`/);
    expect(prompt).toMatch(/`meetingKey` from `calendar-list-events`/);
    expect(prompt).not.toMatch(/<eventId>/);
  });

  it("a weekly series' instances keep their own keys; an event without a UID keys on its id", () => {
    const thisWeek = evt('i1', { originalStartTime: 1_795_100_000 });
    const nextWeek = evt('i2', { originalStartTime: 1_795_704_800, startTime: 1_795_704_800, endTime: 1_795_708_400 });
    expect(meetingKey(thisWeek)).not.toBe(meetingKey(nextWeek));
    expect(meetingKey(evt('plain', { icalUid: undefined }))).toBe('plain');
    expect(meetingKey(evt('long', { icalUid: 'x'.repeat(2000) })).length).toBeLessThanOrEqual(40);
  });
});
