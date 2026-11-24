import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { backfillContacts } from '../../../../src/onboarding/deep-dive/backfill.js';
import { BACKFILL_CAP } from '../../../../src/onboarding/deep-dive/limits.js';
import type { Correspondent, HistorySummary } from '../../../../src/onboarding/deep-dive/history-summary.js';

const logger = pino({ level: 'silent' });
const PRINCIPAL = 'boss@acme.com';

function person(email: string, over: Partial<Correspondent> = {}): Correspondent {
  return {
    email,
    name: null,
    domain: email.split('@')[1]!,
    kind: 'person',
    received: 3,
    sent: 2,
    twoWay: true,
    medianReplyMinutes: null,
    evidence: {},
    ...over,
  };
}

function summary(over: Partial<HistorySummary> = {}): HistorySummary {
  return {
    version: 1,
    generatedAt: '2026-11-23T00:00:00.000Z',
    window: { from: '2026-08-25T00:00:00.000Z', to: '2026-11-23T00:00:00.000Z' },
    coverage: { messagesRead: 0, eventsRead: 0, requests: 0, rateLimited: 0, errors: 0, truncated: false },
    principalAddresses: [PRINCIPAL],
    correspondents: [],
    unopened: [],
    handedOff: [],
    recurringMeetings: [],
    meetingShape: { medianMinutes: 0, bufferMinutesMedian: 0, keptClearBlocks: [], declinedOrMoved: 0, evidence: {} },
    timeSpent: [],
    voiceSample: [],
    ...over,
  };
}

function meeting(attendees: string[]): HistorySummary['recurringMeetings'][number] {
  return { title: 'Weekly sync', seriesId: 's1', cadence: 'weekly', minutesPerOccurrence: 30, attendees, evidence: {} };
}

function setup(opts: { existing?: string[]; linkError?: (email: string) => Error | undefined } = {}) {
  const existing = new Set((opts.existing ?? []).map((e) => e.toLowerCase()));
  let n = 0;
  const contactService = {
    resolveByChannelIdentity: vi.fn(async (_c: string, id: string) => (existing.has(id.toLowerCase()) ? ({ id: 'x' } as never) : null)),
    createContactWithKgOutcome: vi.fn(async () => ({ contact: { id: `c${++n}` } as never, kgNodeCreated: true })),
    linkIdentity: vi.fn(async (o: { channelIdentifier: string }) => {
      const err = opts.linkError?.(o.channelIdentifier);
      if (err) throw err;
      return {} as never;
    }),
    deleteContact: vi.fn(async () => undefined),
  };
  return contactService;
}

const created = (svc: ReturnType<typeof setup>) =>
  svc.createContactWithKgOutcome.mock.calls.map((c) => (c as unknown as [Record<string, unknown>])[0]);

describe('backfillContacts', () => {
  it('creates contacts for two-way people only', async () => {
    const svc = setup();
    const result = await backfillContacts(
      { contactService: svc, logger },
      summary({ correspondents: [person('ann@corp.io', { name: ' Ann Lee ' }), person('bob@gmail.com')] }),
    );
    expect(result).toEqual({ created: 2, existing: 0, skipped: 0 });
    expect(created(svc)).toEqual([
      { displayName: 'Ann Lee', fallbackDisplayName: 'ann@corp.io', source: 'email_participant', tier: 'unknown', primaryEmail: 'ann@corp.io', organization: 'Corp' },
      { displayName: 'bob@gmail.com', fallbackDisplayName: 'bob@gmail.com', source: 'email_participant', tier: 'unknown', primaryEmail: 'bob@gmail.com' },
    ]);
    expect(svc.linkIdentity).toHaveBeenCalledWith({ contactId: 'c1', channel: 'email', channelIdentifier: 'ann@corp.io', source: 'email_participant' });
  });

  it('skips one-way, automated and organisation senders', async () => {
    const svc = setup();
    const result = await backfillContacts(
      { contactService: svc, logger },
      summary({
        correspondents: [
          person('oneway@corp.io', { sent: 0, twoWay: false }),
          person('noreply@corp.io', { kind: 'automated' }),
          person('info@corp.io', { kind: 'organization' }),
          person('real@corp.io'),
        ],
      }),
    );
    expect(result.created).toBe(1);
    expect(created(svc).map((c) => c.primaryEmail)).toEqual(['real@corp.io']);
  });

  it('adds recurring-meeting attendees with calendar_attendee source', async () => {
    const svc = setup();
    const result = await backfillContacts(
      { contactService: svc, logger },
      summary({ correspondents: [person('ann@corp.io')], recurringMeetings: [meeting(['Ann@Corp.io', 'dee@other.org', PRINCIPAL])] }),
    );
    expect(result.created).toBe(2);
    expect(created(svc).map((c) => [c.primaryEmail, c.source])).toEqual([
      ['ann@corp.io', 'email_participant'],
      ['dee@other.org', 'calendar_attendee'],
    ]);
    expect(svc.linkIdentity).toHaveBeenLastCalledWith({ contactId: 'c2', channel: 'email', channelIdentifier: 'dee@other.org', source: 'calendar_attendee' });
  });

  it('skips existing contacts', async () => {
    const svc = setup({ existing: ['ann@corp.io'] });
    const result = await backfillContacts({ contactService: svc, logger }, summary({ correspondents: [person('Ann@corp.io'), person('bob@corp.io')] }));
    expect(result).toEqual({ created: 1, existing: 1, skipped: 0 });
  });

  it('stops at BACKFILL_CAP highest-volume first', async () => {
    const svc = setup();
    const many = Array.from({ length: BACKFILL_CAP + 5 }, (_, i) =>
      person(`p${String(i).padStart(3, '0')}@corp.io`, { received: 100 - Math.min(i, 90), sent: 1 }),
    ).reverse();
    const result = await backfillContacts({ contactService: svc, logger }, summary({ correspondents: many }));
    expect(result.created).toBe(BACKFILL_CAP);
    expect(result.skipped).toBe(5);
    expect(created(svc)[0]!.primaryEmail).toBe('p000@corp.io');
    const emails = created(svc).map((c) => c.primaryEmail);
    // received falls with the index until 90, so the highest indexes tie at the bottom: none of the last five is kept.
    expect(emails).not.toContain(`p${String(BACKFILL_CAP + 4).padStart(3, '0')}@corp.io`);
  });

  it("never backfills the principal's addresses", async () => {
    const svc = setup();
    const result = await backfillContacts(
      { contactService: svc, logger },
      summary({
        principalAddresses: [PRINCIPAL, 'Alias@Acme.com'],
        correspondents: [person('BOSS@acme.com'), person('alias@acme.com')],
        recurringMeetings: [meeting(['boss@acme.com', 'ALIAS@acme.com'])],
      }),
    );
    expect(result).toEqual({ created: 0, existing: 0, skipped: 0 });
    expect(svc.resolveByChannelIdentity).not.toHaveBeenCalled();
  });

  it('skips Google room resources', async () => {
    const svc = setup();
    const room = 'c_188abc@resource.calendar.google.com';
    const result = await backfillContacts(
      { contactService: svc, logger },
      summary({ correspondents: [person(room)], recurringMeetings: [meeting([room.toUpperCase(), 'dee@other.org'])] }),
    );
    expect(result.created).toBe(1);
    expect(created(svc).map((c) => c.primaryEmail)).toEqual(['dee@other.org']);
  });

  it('rolls back a contact whose identity link fails', async () => {
    const dup = Object.assign(new Error('duplicate'), { code: '23505' });
    const svc = setup({ linkError: (e) => (e === 'ann@corp.io' ? dup : e === 'bob@corp.io' ? new Error('boom') : undefined) });
    const result = await backfillContacts(
      { contactService: svc, logger },
      summary({ correspondents: [person('ann@corp.io'), person('bob@corp.io'), person('cy@corp.io')] }),
    );
    expect(result).toEqual({ created: 1, existing: 0, skipped: 2 });
    expect(svc.deleteContact).toHaveBeenCalledTimes(2);
    expect(svc.deleteContact).toHaveBeenCalledWith('c1', { archiveAnchoredNode: true });
  });
});
