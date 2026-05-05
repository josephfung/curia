import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SendDraftHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import pino from 'pino';

function makeLogger() {
  return pino({ level: 'silent' });
}

// Minimal draft fixture — shape matches NylasMessage
const DRAFT_STUB = {
  id: 'draft-abc123',
  threadId: '',
  subject: 'Re: Project Update',
  from: [{ email: 'curia@example.com' }],
  to: [{ email: 'kevin@example.com' }],
  cc: [],
  bcc: [],
  body: '<p>Hello Kevin</p>',
  snippet: 'Hello Kevin',
  date: 1746000000, // epoch seconds
  unread: false,
  folders: ['DRAFTS'],
};

function makeCtx(overrides: {
  input?: Record<string, unknown>;
  taskMetadata?: Record<string, unknown> | undefined;
  gateway?: Partial<OutboundGateway>;
  bus?: Partial<EventBus>;
  taskEventId?: string;
  actionLogRepo?: Partial<ActionLogRepo> | null;
}): SkillContext {
  const gateway = {
    listEmailMessages: vi.fn().mockResolvedValue([DRAFT_STUB]),
    sendEmailDraft: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' }),
    ...overrides.gateway,
  } as unknown as OutboundGateway;

  const bus = {
    publish: vi.fn().mockResolvedValue(undefined),
    ...overrides.bus,
  } as unknown as EventBus;

  // Build action log repo — undefined by default (matches pre-existing tests),
  // null means explicitly absent (ctx.actionLogRepo = undefined), or a partial mock.
  const actionLogRepo = overrides.actionLogRepo === null
    ? undefined
    : overrides.actionLogRepo !== undefined
      ? overrides.actionLogRepo as unknown as ActionLogRepo
      : undefined;

  const ctx = {
    input: overrides.input ?? { draft_id: 'draft-abc123', account: 'joseph' },
    secret: () => '',
    log: makeLogger(),
    outboundGateway: gateway,
    bus,
    taskMetadata: 'taskMetadata' in overrides
      ? overrides.taskMetadata
      : { ceoInitiated: true, senderId: '+14155551234', channelId: 'signal' },
    taskEventId: overrides.taskEventId ?? 'task-event-1',
    actionLogRepo,
  } as unknown as SkillContext;

  return ctx;
}

describe('SendDraftHandler', () => {
  let handler: SendDraftHandler;

  beforeEach(() => {
    handler = new SendDraftHandler();
  });

  // ─── Security gate ────────────────────────────────────────────────────────

  it('rejects when ceoInitiated is absent from taskMetadata', async () => {
    const ctx = makeCtx({ taskMetadata: {} });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/CEO authorization|ceoInitiated/i);
  });

  it('rejects when ceoInitiated is false', async () => {
    const ctx = makeCtx({ taskMetadata: { ceoInitiated: false } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('rejects when taskMetadata is undefined', async () => {
    const ctx = makeCtx({ taskMetadata: undefined });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/CEO authorization|ceoInitiated/i);
  });

  // ─── Capability guards ────────────────────────────────────────────────────

  it('returns error when outboundGateway is missing', async () => {
    const ctx = makeCtx({});
    (ctx as Record<string, unknown>).outboundGateway = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/i);
  });

  it('returns error when bus is missing', async () => {
    const ctx = makeCtx({});
    (ctx as Record<string, unknown>).bus = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/bus/i);
  });

  // ─── Input validation ─────────────────────────────────────────────────────

  it('returns error when draft_id is missing', async () => {
    const ctx = makeCtx({ input: { account: 'joseph' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/draft_id/i);
  });

  it('returns error when account is missing', async () => {
    const ctx = makeCtx({ input: { draft_id: 'draft-abc123' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/account/i);
  });

  // ─── Draft lookup ─────────────────────────────────────────────────────────

  it('returns error when DRAFTS folder fetch throws', async () => {
    const ctx = makeCtx({
      gateway: {
        listEmailMessages: vi.fn().mockRejectedValue(new Error('Nylas error')),
        sendEmailDraft: vi.fn(),
      },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/fetch drafts folder/i);
  });

  it('returns error when draft is not found in DRAFTS folder', async () => {
    const ctx = makeCtx({
      gateway: {
        listEmailMessages: vi.fn().mockResolvedValue([]),
        sendEmailDraft: vi.fn(),
      },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not found/i);
  });

  it('returns error when draft has no recipient', async () => {
    const draftNoRecipient = { ...DRAFT_STUB, to: [] };
    const ctx = makeCtx({
      gateway: {
        listEmailMessages: vi.fn().mockResolvedValue([draftNoRecipient]),
        sendEmailDraft: vi.fn(),
      },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/recipient/i);
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  it('sends draft successfully and returns message_id, to, subject', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.to).toBe('kevin@example.com');
      expect(data.subject).toBe('Re: Project Update');
      expect(data.message_id).toBe('msg-sent-1');
    }
  });

  it('calls gateway.sendEmailDraft with humanApproved: true and correct draftId/account', async () => {
    const sendEmailDraftMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
    const ctx = makeCtx({ gateway: { sendEmailDraft: sendEmailDraftMock } });
    await handler.execute(ctx);
    expect(sendEmailDraftMock).toHaveBeenCalledWith(
      'draft-abc123',
      'joseph',
      expect.objectContaining({ recipientEmail: 'kevin@example.com' }),
      { humanApproved: true },
    );
  });

  it('passes draft body and subject to gateway for safety checks', async () => {
    const sendEmailDraftMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
    const ctx = makeCtx({ gateway: { sendEmailDraft: sendEmailDraftMock } });
    await handler.execute(ctx);
    expect(sendEmailDraftMock).toHaveBeenCalledWith(
      'draft-abc123',
      'joseph',
      {
        recipientEmail: 'kevin@example.com',
        body: '<p>Hello Kevin</p>',
        subject: 'Re: Project Update',
      },
      { humanApproved: true },
    );
  });

  it('returns error when gateway blocks the send', async () => {
    const ctx = makeCtx({
      gateway: {
        sendEmailDraft: vi.fn().mockResolvedValue({ success: false, blockedReason: 'Recipient is blocked' }),
      },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/blocked/i);
  });

  it('publishes a human.decision event after successful send', async () => {
    const publishMock = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ bus: { publish: publishMock } });

    await handler.execute(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'human.decision',
        payload: expect.objectContaining({
          decision: 'approve',
          defaultAction: 'block',
        }),
      }),
    );
  });

  it('still returns success even when human.decision publish fails', async () => {
    // The message was sent — audit event failure must not retroactively fail the skill.
    const publishMock = vi.fn().mockRejectedValue(new Error('bus error'));
    const ctx = makeCtx({ bus: { publish: publishMock } });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
  });

  // ─── action_log transition on approval ───────────────────────────────────

  describe('action_log transition on approval', () => {
    it('transitions matching action_log row to approved on successful send', async () => {
      // Arrange: actionLogRepo finds a matching pending row for the draft
      const mockRow = { id: 55 };
      const findPendingByPayloadField = vi.fn().mockResolvedValue(mockRow);
      const resolveById = vi.fn().mockResolvedValue(true);
      const ctx = makeCtx({
        actionLogRepo: { findPendingByPayloadField, resolveById },
      });

      // Act
      const result = await handler.execute(ctx);

      // Assert: send succeeded and action_log was transitioned
      expect(result.success).toBe(true);
      expect(findPendingByPayloadField).toHaveBeenCalledWith('draft_id', 'draft-abc123');
      expect(resolveById).toHaveBeenCalledWith(55, 'approved', 'ceo');
    });

    it('still succeeds when no action_log row exists (pre-existing draft)', async () => {
      // findPendingByPayloadField returns null — draft was not created via the autonomy gate
      const findPendingByPayloadField = vi.fn().mockResolvedValue(null);
      const resolveById = vi.fn();
      const ctx = makeCtx({
        actionLogRepo: { findPendingByPayloadField, resolveById },
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      // resolveById must NOT be called when no row was found
      expect(resolveById).not.toHaveBeenCalled();
    });

    it('still succeeds when actionLogRepo is not available', async () => {
      // No actionLogRepo in ctx — older code paths, or skills without the capability
      const ctx = makeCtx({ actionLogRepo: null });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
    });

    it('still succeeds when action_log transition throws', async () => {
      // Best-effort: failure in the action_log path must not fail the skill —
      // the email has already been sent at this point.
      const findPendingByPayloadField = vi.fn().mockRejectedValue(new Error('DB error'));
      const ctx = makeCtx({
        actionLogRepo: { findPendingByPayloadField, resolveById: vi.fn() },
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
    });
  });
});
