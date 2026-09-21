import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailSendHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import pino from 'pino';

function makeLogger() {
  return pino({ level: 'silent' });
}

function makeCtx(input: Record<string, unknown>, opts?: { taskMetadata?: Record<string, unknown> }): ToolContext {
  const gateway = {
    send: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as OutboundGateway;

  return {
    input,
    secret: (name: string) => { throw new Error(`Missing secret: ${name}`); },
    log: makeLogger(),
    outboundGateway: gateway,
    taskMetadata: opts?.taskMetadata,
  } as unknown as ToolContext;
}

describe('EmailSendHandler', () => {
  let handler: EmailSendHandler;

  beforeEach(() => {
    handler = new EmailSendHandler();
  });

  it('returns error when to is missing', async () => {
    const ctx = makeCtx({ subject: 'Hello', body: 'Body text' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/to/);
  });

  it('returns error when subject is missing', async () => {
    const ctx = makeCtx({ to: 'alice@example.com', body: 'Body text' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/subject/);
  });

  it('returns error when body is missing', async () => {
    const ctx = makeCtx({ to: 'alice@example.com', subject: 'Hello' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/body/);
  });

  it('returns error when to is an invalid email', async () => {
    const ctx = makeCtx({ to: 'not-an-email', subject: 'Hello', body: 'Body' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Invalid email/i);
  });

  it('returns error when multiple to addresses are provided', async () => {
    const ctx = makeCtx({ to: 'alice@example.com,bob@example.com', subject: 'Hello', body: 'Body' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/single/i);
  });

  it('returns error when outboundGateway is not available', async () => {
    const ctx = makeCtx({ to: 'alice@example.com', subject: 'Hello', body: 'Body' });
    (ctx as unknown as Record<string, unknown>).outboundGateway = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/);
  });

  it('sends an email and returns message_id, to, and subject', async () => {
    const ctx = makeCtx({ to: 'alice@example.com', subject: 'Hello', body: 'Hi there' });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'msg-123',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).message_id).toBe('msg-123');
      expect((result.data as Record<string, unknown>).to).toBe('alice@example.com');
      expect((result.data as Record<string, unknown>).subject).toBe('Hello');
    }
    expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', to: 'alice@example.com', subject: 'Hello', body: 'Hi there' }),
      { taskEventId: undefined, conversationId: undefined },
    );
  });

  it('reads the quoted original and sends from the named account (#1832)', async () => {
    const ctx = makeCtx({
      to: 'alice@example.com',
      subject: 'Re: Hello',
      body: 'Hi there',
      reply_to_message_id: 'msg-sec',
      account: 'personal',
    });
    const getEmailMessage = vi.fn().mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [],
      cc: [],
      subject: 'Hello',
      body: '<p>Original</p>',
      date: 1700000000,
    });
    (ctx.outboundGateway as unknown as { getEmailMessage: ReturnType<typeof vi.fn> }).getEmailMessage = getEmailMessage;
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'msg-123',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(getEmailMessage).toHaveBeenCalledWith('msg-sec', 'personal');
    expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'personal', replyToMessageId: 'msg-sec' }),
      expect.anything(),
    );
  });

  it('rejects account on a new email that is not a threaded reply (#1832)', async () => {
    const ctx = makeCtx({
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'Hi there',
      account: 'ceo',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/reply_to_message_id/);
    expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
  });

  it('returns error when gateway blocks the send', async () => {
    const ctx = makeCtx({ to: 'alice@example.com', subject: 'Hello', body: 'Body' });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false, blockedReason: 'Recipient is blocked',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/blocked/i);
  });

  describe('attachments', () => {
    it('passes attachments to the gateway when provided', async () => {
      const ctx = makeCtx({
        to: 'alice@example.com',
        subject: 'See attached',
        body: 'Please find attached.',
        attachments: [
          { file_url: 'file:///tmp/report.pdf', filename: 'report.pdf', content_type: 'application/pdf' },
        ],
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-attach-1',
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const callArgs = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs.attachments).toEqual([
        { fileUrl: 'file:///tmp/report.pdf', filename: 'report.pdf', contentType: 'application/pdf' },
      ]);
    });

    it('does not include attachments key when attachments is undefined', async () => {
      const ctx = makeCtx({
        to: 'alice@example.com',
        subject: 'Hello',
        body: 'Hi there',
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-1',
      });

      await handler.execute(ctx);

      const callArgs = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs.attachments).toBeUndefined();
    });

    it('returns error when attachments is not an array', async () => {
      const ctx = makeCtx({
        to: 'alice@example.com',
        subject: 'Hello',
        body: 'Hi',
        attachments: 'not-an-array',
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('array');
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it('returns error when an attachment entry is missing file_url', async () => {
      const ctx = makeCtx({
        to: 'alice@example.com',
        subject: 'Hello',
        body: 'Hi',
        attachments: [{ filename: 'a.pdf', content_type: 'application/pdf' }],
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('file_url');
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });
  });

  describe('context_bridge', () => {
    it('registers a context bridge entry after successful send', async () => {
      const ctx = makeCtx({
        to: 'alice@example.com',
        subject: 'Meeting follow-up',
        body: 'Any thoughts on the proposal?',
        context_bridge: JSON.stringify({
          agent_id: 'meeting-debrief',
          expected_reply: 'Proposal feedback',
          delegation_hint: 'Delegate to meeting-debrief',
          expires_in_hours: 72,
        }),
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-1',
      });
      const mockRegister = vi.fn().mockResolvedValue('entry-1');
      (ctx as unknown as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
        defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? 72 : 6),
      };
      (ctx as unknown as Record<string, unknown>).agentId = 'coordinator';

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(mockRegister).toHaveBeenCalledWith({
        channelId: 'email',
        agentId: 'meeting-debrief',
        content: 'Any thoughts on the proposal?',
        expectedReply: 'Proposal feedback',
        delegationHint: 'Delegate to meeting-debrief',
        expiresInHours: 72,
        ttlSource: 'agent',
      });
    });

    it('registers a minimal entry when context_bridge is absent', async () => {
      const ctx = makeCtx({
        to: 'alice@example.com',
        subject: 'Hello',
        body: 'Hi there',
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-1',
      });
      const mockRegister = vi.fn().mockResolvedValue('entry-1');
      (ctx as unknown as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
        defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? 72 : 6),
      };
      (ctx as unknown as Record<string, unknown>).agentId = 'coordinator';

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(mockRegister).toHaveBeenCalledWith({
        channelId: 'email',
        agentId: 'coordinator',
        content: 'Hi there',
        // Email's channel default, not the flat 6h that expired before
        // next-business-day replies could land (#1816).
        expiresInHours: 72,
        ttlSource: 'channel-default',
      });
    });

    it('logs warning but succeeds when bridge registration fails', async () => {
      const ctx = makeCtx({
        to: 'alice@example.com',
        subject: 'Hello',
        body: 'Hi there',
        context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-1',
      });
      const mockRegister = vi.fn().mockRejectedValue(new Error('DB error'));
      (ctx as unknown as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
        defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? 72 : 6),
      };
      (ctx as unknown as Record<string, unknown>).agentId = 'coordinator';

      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
    });
  });

  describe('auto-generated sender suppress (#1734)', () => {
    it('blocks email-send to the machine sender when autoGeneratedSuppress is stamped', async () => {
      const ctx = makeCtx(
        { to: 'machine@exchange.example', subject: 'Ack', body: 'Got it' },
        {
          taskMetadata: {
            autoGeneratedSuppress: true,
            autoGeneratedSenderId: 'machine@exchange.example',
          },
        },
      );

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/auto-generated/i);
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it('allows email-send to the principal on an auto-generated turn', async () => {
      const ctx = makeCtx(
        { to: 'ceo@example.com', subject: 'Escalation', body: 'Calendar decline from Alice' },
        {
          taskMetadata: {
            autoGeneratedSuppress: true,
            autoGeneratedSenderId: 'machine@exchange.example',
          },
        },
      );

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(ctx.outboundGateway!.send).toHaveBeenCalled();
    });
  });
});
