// approval-trigger.test.ts — unit tests for ApprovalTriggerService.
//
// Tests are structured in two groups:
//   1. Pure functions (shortRefPrefix, buildDescription) — no mocks needed
//   2. request() method (Task 4) — mocks ActionLogRepo and OutboundGateway

import { describe, it, expect, vi } from 'vitest';
import { shortRefPrefix, buildDescription, ApprovalTriggerService } from './approval-trigger.js';
import type { ActionLogRepo } from './action-log-repo.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import { createSilentLogger } from '../logger.js';

describe('shortRefPrefix', () => {
  it('maps calendar-* skills to "cal"', () => {
    expect(shortRefPrefix('calendar-create-event')).toBe('cal');
    expect(shortRefPrefix('calendar-update-event')).toBe('cal');
  });

  it('maps email-* skills to "email"', () => {
    expect(shortRefPrefix('email-reply')).toBe('email');
    expect(shortRefPrefix('email-draft-save')).toBe('email');
  });

  it('maps signal-* skills to "signal"', () => {
    expect(shortRefPrefix('signal-send')).toBe('signal');
  });

  it('maps store-fact to "mem"', () => {
    expect(shortRefPrefix('store-fact')).toBe('mem');
  });

  it('maps *-memory-* skills to "mem"', () => {
    expect(shortRefPrefix('entity-memory-store')).toBe('mem');
  });

  it('maps *-contact* skills to "contact"', () => {
    expect(shortRefPrefix('update-contact')).toBe('contact');
    expect(shortRefPrefix('contact-merge')).toBe('contact');
  });

  it('maps schedule-* skills to "sched"', () => {
    expect(shortRefPrefix('schedule-job')).toBe('sched');
  });

  it('falls back to first word of skill name, truncated to 6 chars', () => {
    expect(shortRefPrefix('something-unusual')).toBe('someth');
    expect(shortRefPrefix('web-search')).toBe('web');
  });
});

describe('buildDescription', () => {
  it('formats calendar-create-event with title', () => {
    const desc = buildDescription('calendar-create-event', { title: 'Lunch with Dana', start: '2026-05-06T12:00:00-04:00' });
    expect(desc).toContain('Create calendar event');
    expect(desc).toContain('Lunch with Dana');
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
    countShortRefsForTask: vi.fn().mockResolvedValue(0),
    insert: vi.fn().mockResolvedValue(1),
    setNotificationSentAt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeMockGateway(overrides?: Partial<OutboundGateway>): OutboundGateway {
  return {
    sendNotification: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as OutboundGateway;
}

const BASE_OPTS = {
  taskId: 'task-1',
  conversationId: 'conv-1',
  skillName: 'calendar-create-event',
  actionRisk: 'high',
  input: { title: 'Lunch with Dana' },
  currentScore: 65,
  requiredScore: 80,
};

describe('ApprovalTriggerService.request()', () => {
  it('creates row, generates short_ref, sends notification, returns created: true', async () => {
    const repo = makeMockRepo();
    const gateway = makeMockGateway();
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    const result = await service.request(BASE_OPTS);

    expect(result).toEqual({
      created: true,
      shortRef: 'cal-1',
      notificationSent: true,
    });
    expect(repo.insert).toHaveBeenCalledOnce();
    expect(repo.setNotificationSentAt).toHaveBeenCalledWith(1);
    expect(gateway.sendNotification).toHaveBeenCalledOnce();
    // Verify notification payload — type, recipient, subject, and required body fields
    const notifPayload = (gateway.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(notifPayload.notificationType).toBe('approval_requested');
    expect(notifPayload.ceoEmail).toBe('ceo@example.com');
    expect(notifPayload.subject).toContain('Approval needed');
    expect(notifPayload.body).toContain('cal-1');           // short_ref
    expect(notifPayload.body).toMatch(/Expires:/);          // expiry line
    expect(notifPayload.body).toContain('Reply to approve'); // call to action
  });

  it('returns duplicate when matching pending row exists', async () => {
    const repo = makeMockRepo({
      findPendingByTaskAndSkill: vi.fn().mockResolvedValue({ shortRef: 'cal-1' }),
    });
    const gateway = makeMockGateway();
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    const result = await service.request(BASE_OPTS);

    expect(result).toEqual({
      created: false,
      reason: 'duplicate',
      existingShortRef: 'cal-1',
    });
    expect(repo.insert).not.toHaveBeenCalled();
    expect(gateway.sendNotification).not.toHaveBeenCalled();
  });

  it('allows different payloads for same skill in same task', async () => {
    const repo = makeMockRepo({
      // First call: no match (different payload). countShortRefs returns 1 (one already exists).
      findPendingByTaskAndSkill: vi.fn().mockResolvedValue(null),
      countShortRefsForTask: vi.fn().mockResolvedValue(1),
    });
    const gateway = makeMockGateway();
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    const result = await service.request({
      ...BASE_OPTS,
      input: { title: 'Dinner with Bob' },
    });

    expect(result).toEqual({
      created: true,
      shortRef: 'cal-2',  // counter is 1, so next is 2
      notificationSent: true,
    });
  });

  it('handles notification failure gracefully', async () => {
    const repo = makeMockRepo();
    // sendNotification() catches publish errors internally and returns false rather than throwing
    const gateway = makeMockGateway({
      sendNotification: vi.fn().mockResolvedValue(false),
    });
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    const result = await service.request(BASE_OPTS);

    expect(result).toEqual({
      created: true,
      shortRef: 'cal-1',
      notificationSent: false,
    });
    // Row was still inserted
    expect(repo.insert).toHaveBeenCalledOnce();
    // setNotificationSentAt was NOT called (notification failed)
    expect(repo.setNotificationSentAt).not.toHaveBeenCalled();
  });

  it('skips notification when ceoEmail is not configured', async () => {
    const repo = makeMockRepo();
    const gateway = makeMockGateway();
    // No ceoEmail
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger());

    const result = await service.request(BASE_OPTS);

    expect(result).toEqual({
      created: true,
      shortRef: 'cal-1',
      notificationSent: false,
    });
    expect(repo.insert).toHaveBeenCalledOnce();
    expect(gateway.sendNotification).not.toHaveBeenCalled();
  });

  it('creates row successfully when outboundGateway is undefined', async () => {
    const repo = makeMockRepo();
    // No gateway at all — row creation must not depend on the outbound stack
    const service = new ApprovalTriggerService(repo, undefined, createSilentLogger(), 'ceo@example.com');

    const result = await service.request(BASE_OPTS);

    expect(result).toEqual({
      created: true,
      shortRef: 'cal-1',
      notificationSent: false,
    });
    expect(repo.insert).toHaveBeenCalledOnce();
  });

  it('inserts row with correct fields', async () => {
    const FIXED_NOW = 1_746_000_000_000; // 2025-04-30T06:40:00Z — arbitrary fixed point
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    try {
      const repo = makeMockRepo();
      const gateway = makeMockGateway();
      const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

      await service.request(BASE_OPTS);

      const insertCall = (repo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(insertCall.taskId).toBe('task-1');
      expect(insertCall.conversationId).toBe('conv-1');
      expect(insertCall.skillName).toBe('calendar-create-event');
      expect(insertCall.actionRisk).toBe('high');
      expect(insertCall.outcome).toBe('pending_approval');
      expect(insertCall.payload).toEqual({ title: 'Lunch with Dana' });
      expect(insertCall.shortRef).toBe('cal-1');
      expect(insertCall.description).toContain('Create calendar event');
      expect(insertCall.expiresAt).toBeInstanceOf(Date);
      // Expires exactly 24h from the frozen now — deterministic, no tolerance needed
      expect(insertCall.expiresAt.getTime()).toBe(FIXED_NOW + 86_400_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
