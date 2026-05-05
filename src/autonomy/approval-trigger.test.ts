// approval-trigger.test.ts — unit tests for ApprovalTriggerService.
//
// Tests are structured in two groups:
//   1. Pure functions (generateShortRef, buildDescription) — no mocks needed
//   2. request() method — mocks ActionLogRepo and OutboundGateway

import { describe, it, expect, vi } from 'vitest';
import { generateShortRef, buildDescription, ApprovalTriggerService } from './approval-trigger.js';
import type { ActionLogRepo } from './action-log-repo.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import { createSilentLogger } from '../logger.js';

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

    expect(result).toMatchObject({
      created: true,
      shortRef: expect.stringMatching(/^[0-9a-f]{8}$/),
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
    // Body must contain the actual short_ref that was generated
    if (result.created) {
      expect(notifPayload.body).toContain(result.shortRef);
    }
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
      findPendingByTaskAndSkill: vi.fn().mockResolvedValue(null),
    });
    const gateway = makeMockGateway();
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    const result = await service.request({
      ...BASE_OPTS,
      input: { title: 'Dinner with Bob' },
    });

    expect(result).toMatchObject({
      created: true,
      shortRef: expect.stringMatching(/^[0-9a-f]{8}$/),
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

    expect(result).toMatchObject({
      created: true,
      shortRef: expect.stringMatching(/^[0-9a-f]{8}$/),
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

    expect(result).toMatchObject({
      created: true,
      shortRef: expect.stringMatching(/^[0-9a-f]{8}$/),
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

    expect(result).toMatchObject({
      created: true,
      shortRef: expect.stringMatching(/^[0-9a-f]{8}$/),
      notificationSent: false,
    });
    expect(repo.insert).toHaveBeenCalledOnce();
  });

  it('retries on unique_violation (23505) and succeeds with a new random ref', async () => {
    // First insert throws unique_violation; second succeeds with a freshly generated ref.
    const insertMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('unique_violation'), { code: '23505' }))
      .mockResolvedValueOnce(2);
    const repo = makeMockRepo({ insert: insertMock });
    const gateway = makeMockGateway();
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    const result = await service.request(BASE_OPTS);

    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.shortRef).toMatch(/^[0-9a-f]{8}$/);
    }
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
    const repo = makeMockRepo({ insert: insertMock });
    const gateway = makeMockGateway();
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    await expect(service.request(BASE_OPTS)).rejects.toThrow('failed to insert after 3 attempts');
    expect(insertMock).toHaveBeenCalledTimes(3);
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
