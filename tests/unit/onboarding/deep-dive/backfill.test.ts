import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { backfillContacts } from '../../../../src/onboarding/deep-dive/backfill.js';
import { BACKFILL_CAP } from '../../../../src/onboarding/deep-dive/limits.js';
import type { Correspondent, HistorySummary } from '../../../../src/onboarding/deep-dive/history-summary.js';

const logger = pino({ level: 'silent' });
const noOffice = async (): Promise<string[]> => [];
const PRINCIPAL = 'boss@example.org';

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
      { contactService: svc, officeAddresses: noOffice, logger },
      summary({ correspondents: [person('ann@example.com', { name: ' Ann Lee ' }), person('bob@gmail.com')] }),
    );
    expect(result).toEqual({ created: 2, existing: 0, skipped: 0 });
    expect(created(svc)).toEqual([
      { displayName: 'Ann Lee', fallbackDisplayName: 'ann@example.com', source: 'email_participant', tier: 'unknown', primaryEmail: 'ann@example.com', organization: 'Example' },
      { displayName: 'bob@gmail.com', fallbackDisplayName: 'bob@gmail.com', source: 'email_participant', tier: 'unknown', primaryEmail: 'bob@gmail.com' },
    ]);
    expect(svc.linkIdentity).toHaveBeenCalledWith({ contactId: 'c1', channel: 'email', channelIdentifier: 'ann@example.com', source: 'email_participant' });
  });

  it('skips one-way, automated and organisation senders', async () => {
    const svc = setup();
    const result = await backfillContacts(
      { contactService: svc, officeAddresses: noOffice, logger },
      summary({
        correspondents: [
          person('oneway@example.com', { sent: 0, twoWay: false }),
          person('noreply@example.com', { kind: 'automated' }),
          person('info@example.com', { kind: 'organization' }),
          person('real@example.com'),
        ],
      }),
    );
    expect(result.created).toBe(1);
    expect(created(svc).map((c) => c.primaryEmail)).toEqual(['real@example.com']);
  });

  it('adds recurring-meeting attendees with calendar_attendee source', async () => {
    const svc = setup();
    const result = await backfillContacts(
      { contactService: svc, officeAddresses: noOffice, logger },
      summary({ correspondents: [person('ann@example.com')], recurringMeetings: [meeting(['Ann@Example.com', 'dee@example.net', PRINCIPAL])] }),
    );
    expect(result.created).toBe(2);
    expect(created(svc).map((c) => [c.primaryEmail, c.source])).toEqual([
      ['ann@example.com', 'email_participant'],
      ['dee@example.net', 'calendar_attendee'],
    ]);
    expect(svc.linkIdentity).toHaveBeenLastCalledWith({ contactId: 'c2', channel: 'email', channelIdentifier: 'dee@example.net', source: 'calendar_attendee' });
  });

  it('skips existing contacts', async () => {
    const svc = setup({ existing: ['ann@example.com'] });
    const result = await backfillContacts({ contactService: svc, officeAddresses: noOffice, logger }, summary({ correspondents: [person('Ann@example.com'), person('bob@example.com')] }));
    expect(result).toEqual({ created: 1, existing: 1, skipped: 0 });
  });

  it('stops at BACKFILL_CAP highest-volume first', async () => {
    const svc = setup();
    const many = Array.from({ length: BACKFILL_CAP + 5 }, (_, i) =>
      person(`p${String(i).padStart(3, '0')}@example.com`, { received: 100 - Math.min(i, 90), sent: 1 }),
    ).reverse();
    const result = await backfillContacts({ contactService: svc, officeAddresses: noOffice, logger }, summary({ correspondents: many }));
    expect(result.created).toBe(BACKFILL_CAP);
    expect(result.skipped).toBe(5);
    expect(created(svc)[0]!.primaryEmail).toBe('p000@example.com');
    const emails = created(svc).map((c) => c.primaryEmail);
    // received falls with the index until 90, so the highest indexes tie at the bottom: none of the last five is kept.
    expect(emails).not.toContain(`p${String(BACKFILL_CAP + 4).padStart(3, '0')}@example.com`);
  });

  it('reaches new people past existing contacts on a re-run', async () => {
    const busy = Array.from({ length: BACKFILL_CAP }, (_, i) => person(`old${i}@example.com`, { received: 500, sent: 1 }));
    const svc = setup({ existing: busy.map((c) => c.email) });
    const result = await backfillContacts({ contactService: svc, officeAddresses: noOffice, logger }, summary({ correspondents: [...busy, person('new@example.com')] }));
    expect(result).toEqual({ created: 1, existing: BACKFILL_CAP, skipped: 0 });
    expect(created(svc).map((c) => c.primaryEmail)).toEqual(['new@example.com']);
  });

  it("never backfills the principal's addresses", async () => {
    const svc = setup();
    const result = await backfillContacts(
      { contactService: svc, officeAddresses: noOffice, logger },
      summary({
        principalAddresses: [PRINCIPAL, 'Alias@Example.org'],
        correspondents: [person('BOSS@example.org'), person('alias@example.org')],
        recurringMeetings: [meeting(['boss@example.org', 'ALIAS@example.org'])],
      }),
    );
    expect(result).toEqual({ created: 0, existing: 0, skipped: 0 });
    expect(svc.resolveByChannelIdentity).not.toHaveBeenCalled();
  });

  it("never backfills Curia's own mailbox addresses, plus-addresses included", async () => {
    const svc = setup();
    const result = await backfillContacts(
      { contactService: svc, officeAddresses: async () => ['Curia@example.com', 'assistant@example.net'], logger },
      summary({
        correspondents: [person('curia+triage@example.com'), person('ASSISTANT@example.net'), person('ann@example.com')],
        recurringMeetings: [meeting(['curia@EXAMPLE.com', 'dee@example.net'])],
      }),
    );
    expect(result).toEqual({ created: 2, existing: 0, skipped: 0 });
    expect(created(svc).map((c) => c.primaryEmail)).toEqual(['ann@example.com', 'dee@example.net']);
  });

  it('logs a skipped candidate by place and source, never by address', async () => {
    const lines: string[] = [];
    const capture = pino({ level: 'warn' }, { write: (l: string) => { lines.push(l); } });
    const svc = setup({ linkError: (e) => (e === 'bob@example.com' ? new Error('boom') : undefined) });
    await backfillContacts(
      { contactService: svc, officeAddresses: noOffice, logger: capture },
      summary({ correspondents: [person('ann@example.com', { received: 9 }), person('bob@example.com')] }),
    );
    const skipped = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'deep-dive backfill: skipped a candidate after an error')!;
    expect(skipped).toMatchObject({ index: 1, source: 'email_participant' });
    expect(JSON.stringify(skipped)).not.toContain('bob@');
  });

  it('skips Google room resources', async () => {
    const svc = setup();
    const room = 'c_188abc@resource.calendar.google.com';
    const result = await backfillContacts(
      { contactService: svc, officeAddresses: noOffice, logger },
      summary({ correspondents: [person(room)], recurringMeetings: [meeting([room.toUpperCase(), 'dee@example.net'])] }),
    );
    expect(result.created).toBe(1);
    expect(created(svc).map((c) => c.primaryEmail)).toEqual(['dee@example.net']);
  });

  it('rolls back a contact whose identity link fails', async () => {
    const dup = Object.assign(new Error('duplicate'), { code: '23505' });
    const svc = setup({ linkError: (e) => (e === 'ann@example.com' ? dup : e === 'bob@example.com' ? new Error('boom') : undefined) });
    const result = await backfillContacts(
      { contactService: svc, officeAddresses: noOffice, logger },
      summary({ correspondents: [person('ann@example.com'), person('bob@example.com'), person('cy@example.com')] }),
    );
    expect(result).toEqual({ created: 1, existing: 0, skipped: 2 });
    expect(svc.deleteContact).toHaveBeenCalledTimes(2);
    expect(svc.deleteContact).toHaveBeenCalledWith('c1', { archiveAnchoredNode: true });
  });
});
