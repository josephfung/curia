// handler.test.ts — unit tests for approval-expiry-sweep skill handler.
//
// Tests cover: no-op on empty results, batch expiry, notification filtering
// by risk tier, batched single notification, missing CEO email, non-fatal
// sendNotification failure, and unexpected DB errors.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApprovalExpirySweepHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ActionLogRow } from '../../src/autonomy/action-log-types.js';

// --- Fixtures ---

function makeRow(overrides: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id: 1,
    shortRef: 'cal-1',
    skillName: 'create-calendar-event',
    description: 'Create event: Lunch',
    actionRisk: 'medium',
    outcome: 'pending_approval',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() - 1000), // already expired
    resolvedAt: null,
    resolvedBy: null,
    taskId: 'task-1',
    conversationId: null,
    taskSummary: null,
    competenceFlag: null,
    commitmentFlag: null,
    compatibility: null,
    scoredBy: null,
    payload: {},
    notificationSentAt: null,
    parentActionId: null,
    ...overrides,
  };
}

function makeCtx(overrides: {
  findExpiredRows?: ActionLogRow[];
  expireRowsCount?: number;
  sendNotificationResult?: boolean;
  ceoEmail?: string;
} = {}): SkillContext {
  const {
    findExpiredRows = [],
    expireRowsCount = findExpiredRows.length,
    sendNotificationResult = true,
    ceoEmail = 'ceo@example.com',
  } = overrides;

  // The handler reads CEO_PRIMARY_EMAIL from process.env directly (not ctx.secret),
  // so set it here. Tests that need it absent should pass ceoEmail: ''.
  process.env['CEO_PRIMARY_EMAIL'] = ceoEmail;

  return {
    input: {},
    secret: vi.fn().mockReturnValue(''),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    actionLogRepo: {
      findExpired: vi.fn().mockResolvedValue(findExpiredRows),
      expireRows: vi.fn().mockResolvedValue(expireRowsCount),
    } as any,
    outboundGateway: {
      sendNotification: vi.fn().mockResolvedValue(sendNotificationResult),
    } as any,
  } as SkillContext;
}

afterEach(() => {
  // Clean up the env var between tests so they don't bleed into each other.
  delete process.env['CEO_PRIMARY_EMAIL'];
});

// --- Tests ---

describe('ApprovalExpirySweepHandler', () => {
  it('returns {expired:0, notified:0} and sends no notification when no expired rows', async () => {
    const handler = new ApprovalExpirySweepHandler();
    const ctx = makeCtx({ findExpiredRows: [] });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ expired: 0, notified: 0 });
    expect((ctx.outboundGateway as any).sendNotification).not.toHaveBeenCalled();
  });

  it('expires all found rows and logs each', async () => {
    const rows = [
      makeRow({ id: 1, shortRef: 'cal-1', actionRisk: 'low' }),
      makeRow({ id: 2, shortRef: 'email-1', actionRisk: 'medium' }),
    ];
    const handler = new ApprovalExpirySweepHandler();
    const ctx = makeCtx({ findExpiredRows: rows });

    const result = await handler.execute(ctx);

    // expireRows should be called with the IDs of all expired rows
    expect((ctx.actionLogRepo as any).expireRows).toHaveBeenCalledWith([1, 2]);

    // One info log per expired row
    expect((ctx.log as any).info).toHaveBeenCalledTimes(2);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.expired).toBe(2);
  });

  it('sends no notification for low/medium tier expirations', async () => {
    const rows = [
      makeRow({ id: 1, shortRef: 'cal-1', actionRisk: 'low' }),
      makeRow({ id: 2, shortRef: 'email-1', actionRisk: 'medium' }),
    ];
    const handler = new ApprovalExpirySweepHandler();
    const ctx = makeCtx({ findExpiredRows: rows });

    const result = await handler.execute(ctx);

    expect((ctx.outboundGateway as any).sendNotification).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.notified).toBe(0);
  });

  it('sends a single batched notification for high/critical expirations', async () => {
    const rows = [
      makeRow({ id: 1, shortRef: 'low-ref', actionRisk: 'low' }),
      makeRow({ id: 2, shortRef: 'high-ref', actionRisk: 'high' }),
      makeRow({ id: 3, shortRef: 'crit-ref', actionRisk: 'critical' }),
    ];
    const handler = new ApprovalExpirySweepHandler();
    const ctx = makeCtx({ findExpiredRows: rows, ceoEmail: 'ceo@example.com' });

    const result = await handler.execute(ctx);

    // Exactly one batched notification covering the high + critical rows
    expect((ctx.outboundGateway as any).sendNotification).toHaveBeenCalledTimes(1);

    const payload = (ctx.outboundGateway as any).sendNotification.mock.calls[0][0];
    expect(payload.notificationType).toBe('approval_expired');
    expect(payload.ceoEmail).toBe('ceo@example.com');

    // Subject should mention the count of notifiable rows (high + critical = 2)
    expect(payload.subject).toContain('2 request(s)');

    // Body must include both high/critical refs but NOT the low ref
    expect(payload.body).toContain('high-ref');
    expect(payload.body).toContain('crit-ref');
    expect(payload.body).not.toContain('low-ref');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.notified).toBe(2);
  });

  it('skips notification when CEO_PRIMARY_EMAIL is not set', async () => {
    const rows = [makeRow({ id: 1, shortRef: 'high-ref', actionRisk: 'high' })];
    const handler = new ApprovalExpirySweepHandler();
    // Passing ceoEmail: '' causes the helper to set process.env['CEO_PRIMARY_EMAIL'] = ''
    const ctx = makeCtx({ findExpiredRows: rows, ceoEmail: '' });

    const result = await handler.execute(ctx);

    // No notification sent because the email is blank
    expect((ctx.outboundGateway as any).sendNotification).not.toHaveBeenCalled();

    // A warning should be emitted about the missing email
    expect((ctx.log as any).warn).toHaveBeenCalled();

    // Expiry itself still succeeds
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ expired: 1, notified: 0 });
  });

  it('returns notified:0 when sendNotification returns false (non-fatal)', async () => {
    const rows = [makeRow({ id: 1, shortRef: 'crit-ref', actionRisk: 'critical' })];
    const handler = new ApprovalExpirySweepHandler();
    const ctx = makeCtx({ findExpiredRows: rows, sendNotificationResult: false });

    const result = await handler.execute(ctx);

    // The skill should not fail — sendNotification returning false is non-fatal
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ expired: 1, notified: 0 });
  });

  it('returns success:false on unexpected error', async () => {
    const handler = new ApprovalExpirySweepHandler();
    const ctx = makeCtx();

    // Override findExpired to throw unexpectedly
    (ctx.actionLogRepo as any).findExpired = vi.fn().mockRejectedValue(new Error('DB down'));

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error).toContain('DB down');
  });
});
