// handler.test.ts — unit tests for approval-expiry-sweep skill handler.
//
// Tests cover: no-op on empty results, batch expiry, notification filtering
// by risk tier, batched single notification, missing CEO email, missing
// outbound gateway, non-fatal sendNotification failure, and unexpected DB errors.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApprovalExpirySweepHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';
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
  // Rows actually returned by expireRows (RETURNING *). Defaults to findExpiredRows —
  // the common case where no concurrent resolution happened.
  expireRowsResult?: ActionLogRow[];
  sendNotificationResult?: boolean;
  ceoEmail?: string;
  withoutOutboundGateway?: boolean;
} = {}) {
  const {
    findExpiredRows = [],
    expireRowsResult = findExpiredRows,
    sendNotificationResult = true,
    ceoEmail = 'ceo@example.com',
    withoutOutboundGateway = false,
  } = overrides;

  // The handler reads CEO_PRIMARY_EMAIL from process.env directly (not ctx.secret),
  // so set it here. Tests that need it absent should pass ceoEmail: ''.
  process.env['CEO_PRIMARY_EMAIL'] = ceoEmail;

  // Keep explicit references so tests can assert on mock calls without casts.
  const findExpiredMock = vi.fn().mockResolvedValue(findExpiredRows);
  const expireRowsMock = vi.fn().mockResolvedValue(expireRowsResult);
  const sendNotificationMock = vi.fn().mockResolvedValue(sendNotificationResult);
  const logInfoMock = vi.fn();
  const logWarnMock = vi.fn();
  const logErrorMock = vi.fn();

  const ctx: SkillContext = {
    input: {},
    // ctx.secret() throws in production when the var is unset — mirror that here.
    // The handlers read CEO_PRIMARY_EMAIL via process.env directly, so this stub
    // is present for shape correctness only.
    secret: vi.fn().mockImplementation((name: string) => {
      throw new Error(`secret ${name} not configured`);
    }),
    log: { info: logInfoMock, warn: logWarnMock, error: logErrorMock, debug: vi.fn() } as unknown as SkillContext['log'],
    actionLogRepo: {
      findExpired: findExpiredMock,
      expireRows: expireRowsMock,
    } as unknown as ActionLogRepo,
    outboundGateway: withoutOutboundGateway
      ? undefined
      : ({ sendNotification: sendNotificationMock } as unknown as OutboundGateway),
  } as SkillContext;

  return { ctx, findExpiredMock, expireRowsMock, sendNotificationMock, logInfoMock, logWarnMock, logErrorMock };
}

afterEach(() => {
  // Clean up the env var between tests so they don't bleed into each other.
  delete process.env['CEO_PRIMARY_EMAIL'];
});

// --- Tests ---

describe('ApprovalExpirySweepHandler', () => {
  it('returns {expired:0, notified:0} and sends no notification when no expired rows', async () => {
    const handler = new ApprovalExpirySweepHandler();
    const { ctx, sendNotificationMock } = makeCtx({ findExpiredRows: [] });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ expired: 0, notified: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('expires all found rows and logs each actually-expired row', async () => {
    const rows = [
      makeRow({ id: 1, shortRef: 'cal-1', actionRisk: 'low' }),
      makeRow({ id: 2, shortRef: 'email-1', actionRisk: 'medium' }),
    ];
    const handler = new ApprovalExpirySweepHandler();
    const { ctx, expireRowsMock, logInfoMock } = makeCtx({ findExpiredRows: rows });

    const result = await handler.execute(ctx);

    // expireRows should be called with the IDs of all candidate rows
    expect(expireRowsMock).toHaveBeenCalledWith([1, 2]);

    // One info log per actually-expired row (expireRowsResult defaults to findExpiredRows)
    expect(logInfoMock).toHaveBeenCalledTimes(2);

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
    const { ctx, sendNotificationMock } = makeCtx({ findExpiredRows: rows });

    const result = await handler.execute(ctx);

    expect(sendNotificationMock).not.toHaveBeenCalled();
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
    const { ctx, sendNotificationMock } = makeCtx({ findExpiredRows: rows, ceoEmail: 'ceo@example.com' });

    const result = await handler.execute(ctx);

    // Exactly one batched notification covering the high + critical rows
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);

    const payload = sendNotificationMock.mock.calls[0][0];
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

  it('only notifies about rows that actually expired (concurrent resolution)', async () => {
    // findExpired returns 2 candidates, but expireRows only commits 1 (the high one);
    // the critical row was concurrently resolved before the UPDATE ran.
    const highRow = makeRow({ id: 1, shortRef: 'high-ref', actionRisk: 'high' });
    const critRow = makeRow({ id: 2, shortRef: 'crit-ref', actionRisk: 'critical' });
    const handler = new ApprovalExpirySweepHandler();
    const { ctx, sendNotificationMock, logWarnMock } = makeCtx({
      findExpiredRows: [highRow, critRow],
      expireRowsResult: [highRow], // only 1 row actually updated
    });

    const result = await handler.execute(ctx);

    // Warn emitted for concurrent resolution
    expect(logWarnMock).toHaveBeenCalled();

    // Notification built from the 1 actually-expired row only
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const payload = sendNotificationMock.mock.calls[0][0];
    expect(payload.subject).toContain('1 request(s)');
    expect(payload.body).toContain('high-ref');
    expect(payload.body).not.toContain('crit-ref');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.expired).toBe(1);
  });

  it('skips notification when CEO_PRIMARY_EMAIL is not set', async () => {
    const rows = [makeRow({ id: 1, shortRef: 'high-ref', actionRisk: 'high' })];
    const handler = new ApprovalExpirySweepHandler();
    // Passing ceoEmail: '' causes the helper to set process.env['CEO_PRIMARY_EMAIL'] = ''
    const { ctx, sendNotificationMock, logWarnMock } = makeCtx({ findExpiredRows: rows, ceoEmail: '' });

    const result = await handler.execute(ctx);

    // No notification sent because the email is blank
    expect(sendNotificationMock).not.toHaveBeenCalled();

    // A warning should be emitted about the missing email
    expect(logWarnMock).toHaveBeenCalled();

    // Expiry itself still succeeds
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ expired: 1, notified: 0 });
  });

  it('skips notification but still expires when outboundGateway is absent', async () => {
    const rows = [makeRow({ id: 1, shortRef: 'high-ref', actionRisk: 'high' })];
    const handler = new ApprovalExpirySweepHandler();
    const { ctx, sendNotificationMock, logWarnMock } = makeCtx({ findExpiredRows: rows, withoutOutboundGateway: true });

    const result = await handler.execute(ctx);

    // Expiry committed regardless of gateway absence
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ expired: 1, notified: 0 });

    // sendNotification never called (gateway unavailable)
    expect(sendNotificationMock).not.toHaveBeenCalled();

    // Warning emitted for the skipped notification
    expect(logWarnMock).toHaveBeenCalled();
  });

  it('returns notified:0 when sendNotification returns false (non-fatal)', async () => {
    const rows = [makeRow({ id: 1, shortRef: 'crit-ref', actionRisk: 'critical' })];
    const handler = new ApprovalExpirySweepHandler();
    const { ctx } = makeCtx({ findExpiredRows: rows, sendNotificationResult: false });

    const result = await handler.execute(ctx);

    // The skill should not fail — sendNotification returning false is non-fatal
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ expired: 1, notified: 0 });
  });

  it('returns success:false on unexpected error', async () => {
    const handler = new ApprovalExpirySweepHandler();
    const { ctx, findExpiredMock } = makeCtx();

    // Override findExpired to throw unexpectedly
    findExpiredMock.mockRejectedValue(new Error('DB down'));

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error).toContain('DB down');
  });
});
