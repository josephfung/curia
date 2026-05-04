// handler.test.ts — unit tests for pending-actions-digest skill handler.
//
// Tests cover: no-op on empty pending rows, single digest notification,
// time-remaining formatting, missing CEO email, missing outbound gateway,
// non-fatal sendNotification failure, and unexpected DB errors.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PendingActionsDigestHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ActionLogRow } from '../../src/autonomy/action-log-types.js';

// --- Fixed time anchor ---
// Pinning Date.now() makes all expiresAt calculations deterministic.
const FIXED_NOW = 1_000_000_000_000;

// --- Fixtures ---

function makeRow(overrides: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id: 1,
    taskId: 'task-1',
    conversationId: null,
    skillName: 'create-calendar-event',
    actionRisk: 'medium',
    outcome: 'pending_approval',
    taskSummary: null,
    competenceFlag: null,
    commitmentFlag: null,
    compatibility: null,
    scoredBy: null,
    payload: {},
    notificationSentAt: null,
    resolvedAt: null,
    resolvedBy: null,
    // Default: 2 hours in the future from FIXED_NOW
    expiresAt: new Date(FIXED_NOW + 7_200_000),
    parentActionId: null,
    shortRef: 'cal-1',
    description: 'Create event: Lunch',
    createdAt: new Date(FIXED_NOW - 3_600_000),
    ...overrides,
  };
}

function makeCtx(overrides: {
  pendingRows?: ActionLogRow[];
  sendResult?: boolean;
  ceoEmail?: string;
  noOutboundGateway?: boolean;
} = {}): SkillContext {
  const {
    pendingRows = [],
    sendResult = true,
    ceoEmail = 'ceo@example.com',
    noOutboundGateway = false,
  } = overrides;

  // The handler reads CEO_PRIMARY_EMAIL from process.env directly (not ctx.secret()),
  // so set it here. Tests that need it absent should pass ceoEmail: ''.
  process.env['CEO_PRIMARY_EMAIL'] = ceoEmail;

  const ctx: Partial<SkillContext> = {
    input: {},
    secret: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    actionLogRepo: {
      findAllPending: vi.fn().mockResolvedValue(pendingRows),
    } as any,
    outboundGateway: noOutboundGateway
      ? undefined
      : ({
          sendNotification: vi.fn().mockResolvedValue(sendResult),
        } as any),
  };

  return ctx as SkillContext;
}

// --- Lifecycle hooks ---

let dateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dateSpy = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
});

afterEach(() => {
  dateSpy.mockRestore();
  delete process.env['CEO_PRIMARY_EMAIL'];
});

// --- Tests ---

describe('PendingActionsDigestHandler', () => {
  it('returns {pending:0, skipped:true} and sends no notification when no pending rows', async () => {
    const handler = new PendingActionsDigestHandler();
    const ctx = makeCtx({ pendingRows: [] });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 0, skipped: true });
    expect((ctx.outboundGateway as any).sendNotification).not.toHaveBeenCalled();
  });

  it('sends a single digest notification listing all pending rows', async () => {
    const rows = [
      makeRow({ id: 1, shortRef: 'cal-1', description: 'Create event: Lunch', skillName: 'create-calendar-event' }),
      makeRow({ id: 2, shortRef: 'email-2', description: 'Send weekly update', skillName: 'send-email' }),
    ];
    const handler = new PendingActionsDigestHandler();
    const ctx = makeCtx({ pendingRows: rows, ceoEmail: 'ceo@example.com' });

    const result = await handler.execute(ctx);

    expect((ctx.outboundGateway as any).sendNotification).toHaveBeenCalledTimes(1);

    const payload = (ctx.outboundGateway as any).sendNotification.mock.calls[0][0];
    expect(payload.notificationType).toBe('pending_actions_digest');
    expect(payload.ceoEmail).toBe('ceo@example.com');
    expect(payload.subject).toBe('Pending approvals — 2 request(s) awaiting your decision');

    // Both shortRefs must appear in the digest body
    expect(payload.body).toContain('cal-1');
    expect(payload.body).toContain('email-2');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 2, skipped: false });
  });

  it('each entry includes shortRef, description, skillName, and time remaining', async () => {
    const row = makeRow({
      shortRef: 'ref-abc',
      description: 'Book flight to NYC',
      skillName: 'book-travel',
      expiresAt: new Date(FIXED_NOW + 7_200_000), // exactly 2h remaining
    });
    const handler = new PendingActionsDigestHandler();
    const ctx = makeCtx({ pendingRows: [row] });

    await handler.execute(ctx);

    const payload = (ctx.outboundGateway as any).sendNotification.mock.calls[0][0];
    expect(payload.body).toContain('ref-abc');
    expect(payload.body).toContain('Book flight to NYC');
    expect(payload.body).toContain('book-travel');
    expect(payload.body).toContain('2h remaining');
  });

  it('formatTimeRemaining: shows <1h remaining when under 1 hour', async () => {
    const row = makeRow({
      expiresAt: new Date(FIXED_NOW + 1_800_000), // 30 min in the future
    });
    const handler = new PendingActionsDigestHandler();
    const ctx = makeCtx({ pendingRows: [row] });

    await handler.execute(ctx);

    const payload = (ctx.outboundGateway as any).sendNotification.mock.calls[0][0];
    expect(payload.body).toContain('<1h remaining');
  });

  it('skips notification when CEO_PRIMARY_EMAIL is not set', async () => {
    const row = makeRow({ id: 1, shortRef: 'cal-1' });
    const handler = new PendingActionsDigestHandler();
    // Setting ceoEmail: '' causes makeCtx to set process.env['CEO_PRIMARY_EMAIL'] = ''
    const ctx = makeCtx({ pendingRows: [row], ceoEmail: '' });

    const result = await handler.execute(ctx);

    expect((ctx.outboundGateway as any).sendNotification).not.toHaveBeenCalled();
    expect((ctx.log as any).warn).toHaveBeenCalled();

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 1, skipped: true });
  });

  it('skips notification when outboundGateway is not available', async () => {
    const row = makeRow({ id: 1, shortRef: 'cal-1' });
    const handler = new PendingActionsDigestHandler();
    const ctx = makeCtx({ pendingRows: [row], noOutboundGateway: true });

    const result = await handler.execute(ctx);

    // ctx.outboundGateway is undefined — verify no crash and warn emitted
    expect((ctx.log as any).warn).toHaveBeenCalled();

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 1, skipped: true });
  });

  it('handles sendNotification returning false gracefully', async () => {
    const row = makeRow({ id: 1, shortRef: 'cal-1' });
    const handler = new PendingActionsDigestHandler();
    // sendResult: false means the gateway accepted the call but returned false
    const ctx = makeCtx({ pendingRows: [row], sendResult: false });

    const result = await handler.execute(ctx);

    // Non-fatal — skill should still succeed and report skipped:false (the send was attempted)
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 1, skipped: false });
  });

  it('returns success:false on unexpected error', async () => {
    const handler = new PendingActionsDigestHandler();
    const ctx = makeCtx();

    // Override findAllPending to simulate an unexpected DB error
    (ctx.actionLogRepo as any).findAllPending = vi.fn().mockRejectedValue(new Error('DB error'));

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error).toContain('DB error');
  });
});
