import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SendDraftHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import type { EventBus } from '../../src/bus/bus.js';
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
}): SkillContext {
  const gateway = {
    listEmailMessages: vi.fn().mockResolvedValue([DRAFT_STUB]),
    send: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' }),
    ...overrides.gateway,
  } as unknown as OutboundGateway;

  const bus = {
    publish: vi.fn().mockResolvedValue(undefined),
    ...overrides.bus,
  } as unknown as EventBus;

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

  it('returns error when draft is not found in DRAFTS folder', async () => {
    const ctx = makeCtx({
      gateway: {
        listEmailMessages: vi.fn().mockResolvedValue([]),
        send: vi.fn(),
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
        send: vi.fn(),
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

  it('calls gateway.send with humanApproved: true', async () => {
    const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
    const ctx = makeCtx({ gateway: { send: sendMock } });
    await handler.execute(ctx);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', to: 'kevin@example.com' }),
      { humanApproved: true },
    );
  });

  it('resolves reply threading when draft has a threadId', async () => {
    const draftWithThread = { ...DRAFT_STUB, threadId: 'thread-xyz' };
    const threadMessage = { ...DRAFT_STUB, id: 'latest-thread-msg', threadId: 'thread-xyz' };
    const listMock = vi.fn()
      .mockResolvedValueOnce([draftWithThread])  // first call: DRAFTS folder
      .mockResolvedValueOnce([threadMessage]);   // second call: thread lookup
    const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
    const ctx = makeCtx({ gateway: { listEmailMessages: listMock, send: sendMock } });

    await handler.execute(ctx);

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: 'latest-thread-msg' }),
      { humanApproved: true },
    );
  });

  it('sends without replyToMessageId when thread lookup fails (non-fatal)', async () => {
    const draftWithThread = { ...DRAFT_STUB, threadId: 'thread-xyz' };
    const listMock = vi.fn()
      .mockResolvedValueOnce([draftWithThread])
      .mockRejectedValueOnce(new Error('Nylas error'));
    const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
    const ctx = makeCtx({ gateway: { listEmailMessages: listMock, send: sendMock } });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true); // thread lookup failure is non-fatal
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: undefined }),
      { humanApproved: true },
    );
  });

  it('returns error when gateway blocks the send', async () => {
    const ctx = makeCtx({
      gateway: {
        send: vi.fn().mockResolvedValue({ success: false, blockedReason: 'Recipient is blocked' }),
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
});
