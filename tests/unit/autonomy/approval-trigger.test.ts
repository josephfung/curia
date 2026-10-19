// approval-trigger.test.ts — unit tests for ApprovalTriggerService.
//
// Tests are structured in two groups:
//   1. Pure functions (generateShortRef, buildDescription) — no mocks needed
//   2. request() method — mocks ActionLogRepo, the bus and ApprovalDelivery. It notifies no
//      one: the agent delivers the approval on one channel (#2159).

import { describe, it, expect, vi } from 'vitest';
import { generateShortRef, buildDescription, approvalAdvisory, ApprovalTriggerService } from '../../../src/autonomy/approval-trigger.js';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import type { ApprovalDelivery } from '../../../src/autonomy/approval-delivery.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent, PrincipalReportEvent } from '../../../src/bus/events.js';
import type { Logger } from '../../../src/logger.js';

describe('generateShortRef', () => {
  it('returns an 8-char lowercase hex string', () => {
    const ref = generateShortRef();
    expect(ref).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns a different value on each call', () => {
    const refs = new Set(Array.from({ length: 20 }, () => generateShortRef()));
    // With 4B possibilities, 20 calls should all be unique
    expect(refs.size).toBe(20);
  });
});

describe('buildDescription', () => {
  it('formats calendar-create-event with title', () => {
    const desc = buildDescription('calendar-create-event', { title: 'Lunch with Dana', start: '2026-05-06T12:00:00-04:00' });
    expect(desc).toContain('Create calendar event');
    expect(desc).toContain('Lunch with Dana');
  });

  it('formats calendar-respond-to-invite as an RSVP action', () => {
    const desc = buildDescription('calendar-respond-to-invite', { subject: 'Board sync' });
    expect(desc).toContain('Respond to calendar invite');
    expect(desc).toContain('Board sync');
  });

  it('formats email-reply with to and subject', () => {
    const desc = buildDescription('email-reply', { to: 'dana@example.com', subject: 'Re: Budget' });
    expect(desc).toContain('Send email reply');
    expect(desc).toContain('dana@example.com');
    expect(desc).toContain('Re: Budget');
  });

  it('formats store-fact with label', () => {
    const desc = buildDescription('store-fact', { label: 'Dana prefers mornings' });
    expect(desc).toContain('Store fact');
    expect(desc).toContain('Dana prefers mornings');
  });

  // Spot-check pool tools (#2159 Phase 3): a pool summary of "Run ceo-inbox-archive" tells
  // the principal nothing, and the row's description is fixed once written.
  it.each([
    ['ceo-inbox-archive', { message_id: 'm-1' }, 'Archive an email'],
    ['email-archive', { message_id: 'm-1', account: 'work' }, 'Archive an email'],
    ['ceo-inbox-label', { message_id: 'm-1' }, 'Label an email'],
    ['email-label', { message_id: 'm-1' }, 'Label an email'],
    ['contact-merge', { primary_contact_id: 'a', secondary_contact_id: 'b' }, 'Merge contacts'],
    ['contact-set-tier', { contact_id: 'a', tier: 'trusted' }, 'Change a contact\'s trust tier'],
    ['contact-set-role', { contact_id: 'a', role: 'Board member' }, 'Change a contact\'s role'],
    ['executive-profile-update', { writing_voice: { tone: ['warm'] } }, 'Update the principal\'s profile'],
    ['calendar-create-hold', { calendarId: 'c1', start: 's', end: 'e' }, 'Place a calendar hold'],
  ])('describes %s', (tool, input, expected) => {
    expect(buildDescription(tool, input)).toBe(expected);
  });

  it('appends the labels applied by a label tool', () => {
    expect(buildDescription('ceo-inbox-label', { message_id: 'm-1', labels: ['🚨 Urgent', 'BOARD'] }))
      .toBe('Label an email: 🚨 Urgent, BOARD');
    expect(buildDescription('email-label', { message_id: 'm-1', label: 'Receipts' }))
      .toBe('Label an email: Receipts');
  });

  it('appends a calendar hold\'s title', () => {
    expect(buildDescription('calendar-create-hold', { calendarId: 'c1', title: 'Hold: Q4 review' }))
      .toBe('Place a calendar hold: Hold: Q4 review');
    expect(buildDescription('calendar-create-hold', { calendarId: 'c1', subject: 'Intro with Sam' }))
      .toBe('Place a calendar hold: Intro with Sam');
  });

  it('falls back to "Run {skill_name}" for unknown skills', () => {
    const desc = buildDescription('some-unknown-skill', {});
    expect(desc).toBe('Run some-unknown-skill');
  });

  it('returns just the verb for a known skill with no recognized context fields', () => {
    const desc = buildDescription('store-fact', { value: 'something', raw: 'other' });
    expect(desc).toBe('Store fact');
  });

  it('truncates individual values to exactly 80 chars including ellipsis', () => {
    const longTitle = 'A'.repeat(100);
    const desc = buildDescription('calendar-create-event', { title: longTitle });
    // "Create calendar event: " (23 chars) + 79 A's + "…" (1 char) = 103 chars
    expect(desc).toBe('Create calendar event: ' + 'A'.repeat(79) + '…');
  });

  it('truncates the full description to 200 chars', () => {
    const desc = buildDescription('email-reply', {
      to: 'very-long-email-address-that-goes-on-forever@example.com',
      subject: 'Re: A very long subject line that keeps going and going and going',
      body: 'This body is also very long and should not appear in the description',
    });
    expect(desc.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Helpers for request() tests
// ---------------------------------------------------------------------------

function makeMockRepo(overrides?: Partial<ActionLogRepo>): ActionLogRepo {
  return {
    findPendingByTaskAndSkill: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(1),
    findApprovalNumber: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeService(repo: ActionLogRepo, opts: { publishThrows?: boolean } = {}) {
  const published: BusEvent[] = [];
  const bus = {
    publish: vi.fn(async (_layer: string, event: BusEvent) => {
      if (opts.publishThrows) throw new Error('bus down');
      published.push(event);
    }),
  } as unknown as EventBus;
  const approvalDelivery = { registerDisplay: vi.fn() } as unknown as ApprovalDelivery;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const service = new ApprovalTriggerService(repo, logger, bus, approvalDelivery);
  return { service, bus, published, approvalDelivery, logger };
}

const reports = (events: BusEvent[]) =>
  events.filter((e): e is PrincipalReportEvent => e.type === 'principal.report');

const BASE_OPTS = {
  taskId: 'task-1',
  conversationId: 'conv-1',
  toolName: 'calendar-create-event',
  actionRisk: 'high',
  input: { title: 'Lunch with Dana' },
  currentScore: 65,
  requiredScore: 80,
};

describe('approvalAdvisory', () => {
  it('tells the agent to deliver the approval itself, on one channel', () => {
    const text = approvalAdvisory('abcd1234');
    expect(text).toContain('ref: abcd1234');
    expect(text).toContain('deliver-approval');
    expect(text).toMatch(/standing preferences/);
  });

  // deliver-approval is the coordinator's tool; a specialist hands the ref back instead.
  it('tells a specialist to hand the ref to the coordinator', () => {
    const text = approvalAdvisory('abcd1234', 'calendar');
    expect(text).toContain('ref: abcd1234');
    expect(text).toMatch(/tell the coordinator/i);
    expect(approvalAdvisory('abcd1234', 'coordinator')).not.toMatch(/tell the coordinator/i);
  });

  // #2159 Phase 3: the principal answers by number, so the agent should know it. The ref
  // stays: deliver-approval is keyed on it.
  it('quotes the approval number when there is one, and keeps the ref', () => {
    const text = approvalAdvisory('abcd1234', undefined, 3);
    expect(text).toContain('approval 3');
    expect(text).toContain('ref: abcd1234');
    const specialist = approvalAdvisory('abcd1234', 'calendar', 3);
    expect(specialist).toContain('approval 3');
    expect(specialist).toContain('abcd1234');
  });

  it('reads as before without a number', () => {
    expect(approvalAdvisory('abcd1234', undefined, null)).toBe(approvalAdvisory('abcd1234'));
    expect(approvalAdvisory('abcd1234', 'calendar', null)).toBe(approvalAdvisory('abcd1234', 'calendar'));
  });
});

describe('ApprovalTriggerService.request()', () => {
  it('creates the row, queues one digest mention, and notifies no one (#2159)', async () => {
    const repo = makeMockRepo();
    const { service, bus, published } = makeService(repo);

    const result = await service.request(BASE_OPTS);

    expect(result).toEqual({ created: true, shortRef: expect.stringMatching(/^[0-9a-f]{8}$/), approvalNumber: null });
    expect(repo.insert).toHaveBeenCalledOnce();
    // The only thing published is the digest item: no email, no chat DM.
    expect((bus.publish as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    const [item] = reports(published);
    expect(item!.parentEventId).toBe('task-1');
    expect(item!.payload).toEqual({
      summary: 'Waiting for your approval: Create calendar event: Lunch with Dana',
      urgency: 'digest',
      source: 'approval_pending',
      conversationId: 'conv-1',
      actionShortRef: result.created ? result.shortRef : '',
    });
  });

  it('registers the display for delivery: displayInput shown, agent input stored (#2033)', async () => {
    const repo = makeMockRepo();
    const { service, approvalDelivery } = makeService(repo);
    const input = { recipient: '22222222-2222-4222-8222-222222222222', message: 'Confirming Thursday.' };

    const result = await service.request({
      ...BASE_OPTS,
      toolName: 'signal-send',
      input,
      displayInput: { ...input, recipient: '+15550142 (contact "Alex Vendor")' },
    });

    expect(approvalDelivery.registerDisplay).toHaveBeenCalledWith(result.created ? result.shortRef : '', {
      preamble: expect.stringContaining('Curia wanted to send Signal message'),
      payload: { ...input, recipient: '+15550142 (contact "Alex Vendor")' },
      approvalNumber: null,
    });
    // Approval re-runs the skill with the reference, which it re-resolves then.
    expect((repo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0].payload).toEqual(input);
  });

  // #2159 Phase 3: insert() allocates the number; the service reads it back by row id.
  it('returns the approval number read back after insert, and registers it for display', async () => {
    const repo = makeMockRepo({
      insert: vi.fn().mockResolvedValue(55),
      findApprovalNumber: vi.fn().mockResolvedValue(3),
    });
    const { service, approvalDelivery } = makeService(repo);

    const result = await service.request(BASE_OPTS);

    expect(repo.findApprovalNumber).toHaveBeenCalledWith(55);
    expect(result).toEqual({ created: true, shortRef: expect.stringMatching(/^[0-9a-f]{8}$/), approvalNumber: 3 });
    expect(approvalDelivery.registerDisplay).toHaveBeenCalledWith(
      result.created ? result.shortRef : '',
      expect.objectContaining({ approvalNumber: 3 }),
    );
  });

  // The row exists and works by its reference; a failed read must not lose the approval.
  it('still creates the approval, unnumbered, when the number cannot be read back', async () => {
    const repo = makeMockRepo({ findApprovalNumber: vi.fn().mockRejectedValue(new Error('db blip')) });
    const { service, logger } = makeService(repo);

    const result = await service.request(BASE_OPTS);

    expect(result).toMatchObject({ created: true, approvalNumber: null });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('uses the gate reason as the preamble when one is given', async () => {
    const { service, approvalDelivery } = makeService(makeMockRepo());

    await service.request({ ...BASE_OPTS, reason: "The contact's tier requires approval." });

    expect(approvalDelivery.registerDisplay).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      preamble: "The contact's tier requires approval.",
    }));
  });

  it('returns duplicate when matching pending row exists, without a second mention', async () => {
    const repo = makeMockRepo({
      findPendingByTaskAndSkill: vi.fn().mockResolvedValue({ shortRef: 'cal-1' }),
    });
    const { service, bus, approvalDelivery } = makeService(repo);

    const result = await service.request(BASE_OPTS);

    expect(result).toEqual({ created: false, reason: 'duplicate', existingShortRef: 'cal-1' });
    expect(repo.insert).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
    expect(approvalDelivery.registerDisplay).not.toHaveBeenCalled();
  });

  it('still creates the approval when the digest mention fails to queue', async () => {
    const repo = makeMockRepo();
    const { service, logger } = makeService(repo, { publishThrows: true });

    const result = await service.request(BASE_OPTS);

    expect(result.created).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it('retries on unique_violation (23505) and succeeds with a new random ref', async () => {
    // First insert throws unique_violation; second succeeds with a freshly generated ref.
    const insertMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('unique_violation'), { code: '23505' }))
      .mockResolvedValueOnce(2);
    const { service } = makeService(makeMockRepo({ insert: insertMock }));

    const result = await service.request(BASE_OPTS);

    expect(result.created).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(2);
    // Each attempt uses a freshly generated ref — the two insert calls get different short_refs
    const ref1 = insertMock.mock.calls[0]![0].shortRef as string;
    const ref2 = insertMock.mock.calls[1]![0].shortRef as string;
    expect(ref1).not.toBe(ref2);
  });

  it('gives up after 3 retries on persistent unique_violation', async () => {
    const insertMock = vi.fn().mockRejectedValue(
      Object.assign(new Error('unique_violation'), { code: '23505' }),
    );
    const { service } = makeService(makeMockRepo({ insert: insertMock }));

    await expect(service.request(BASE_OPTS)).rejects.toThrow('failed to insert after 3 attempts');
    expect(insertMock).toHaveBeenCalledTimes(3);
  });

  it('inserts row with correct fields', async () => {
    const FIXED_NOW = 1_746_000_000_000; // 2025-04-30T06:40:00Z — arbitrary fixed point
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    try {
      const repo = makeMockRepo();
      const { service } = makeService(repo);

      await service.request(BASE_OPTS);

      const insertCall = (repo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(insertCall.taskId).toBe('task-1');
      expect(insertCall.conversationId).toBe('conv-1');
      expect(insertCall.toolName).toBe('calendar-create-event');
      expect(insertCall.actionRisk).toBe('high');
      expect(insertCall.outcome).toBe('pending_approval');
      expect(insertCall.payload).toEqual({ title: 'Lunch with Dana' });
      expect(insertCall.shortRef).toMatch(/^[0-9a-f]{8}$/); // random globally-unique ref
      expect(insertCall.description).toContain('Create calendar event');
      expect(insertCall.expiresAt).toBeInstanceOf(Date);
      // Expires exactly 24h from the frozen now — deterministic, no tolerance needed
      expect(insertCall.expiresAt.getTime()).toBe(FIXED_NOW + 86_400_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
