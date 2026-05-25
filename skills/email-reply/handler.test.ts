import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailReplyHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import pino from 'pino';

function makeLogger() {
  return pino({ level: 'silent' });
}

function makeCtx(input: Record<string, unknown>, opts?: { timezone?: string }): SkillContext {
  const gateway = {
    send: vi.fn().mockResolvedValue({ success: true }),
    getEmailMessage: vi.fn().mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [],
      cc: [],
      subject: 'Test subject',
      body: '',
      date: 0,
    }),
  } as unknown as OutboundGateway;

  return {
    input,
    secret: (name: string) => { throw new Error(`Missing secret: ${name}`); },
    log: makeLogger(),
    outboundGateway: gateway,
    timezone: opts?.timezone,
  } as unknown as SkillContext;
}

describe('EmailReplyHandler', () => {
  let handler: EmailReplyHandler;

  beforeEach(() => {
    handler = new EmailReplyHandler();
  });

  it('returns error when reply_to_message_id is missing', async () => {
    const ctx = makeCtx({ body: 'Reply body' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/reply_to_message_id/);
  });

  it('returns error when body is missing', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/body/);
  });

  it('returns error when outboundGateway is not available', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Reply body' });
    (ctx as Record<string, unknown>).outboundGateway = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/);
  });

  it('replies to sender and returns expected fields', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!' });
    (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [],
      cc: [],
      subject: 'Project update',
      body: '',
      date: 0,
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'reply-123',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).message_id).toBe('reply-123');
      expect((result.data as Record<string, unknown>).to).toBe('alice@example.com');
      expect((result.data as Record<string, unknown>).subject).toBe('Re: Project update');
    }
  });

  it('returns error when gateway blocks the reply', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!' });
    (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [],
      cc: [],
      subject: 'Hi',
      body: '',
      date: 0,
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false, blockedReason: 'Recipient is blocked',
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/blocked/i);
  });

  describe('reply quote', () => {
    it('appends quoted original message below the reply body', async () => {
      const ctx = makeCtx(
        { reply_to_message_id: 'nylas-msg-1', body: 'Sounds good!' },
        { timezone: 'America/Toronto' },
      );
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ name: 'Alice', email: 'alice@example.com' }],
        to: [{ email: 'curia@example.com' }],
        cc: [],
        subject: 'Q2 planning',
        body: '<p>Let me know your thoughts.</p>',
        date: 1700000000,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-99',
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const sendArg = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
      expect(sendArg.body).toContain('Sounds good!');
      expect(sendArg.body).toContain('---------- Original Message ----------');
      expect(sendArg.body).toContain('Alice <alice@example.com>');
      expect(sendArg.body).toContain('Let me know your thoughts.');
    });

    it('proceeds without quote when buildReplyQuote throws', async () => {
      // Omitting body/date from the mock causes htmlToPlainText(undefined) to throw,
      // exercising the inner try/catch fallback path.
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Got it' });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Test',
        // intentionally omit body and date
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-fallback',
      });
      const warnSpy = vi.fn();
      ctx.log = { ...ctx.log, warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const sendArg = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
      // Body falls back to unquoted
      expect(sendArg.body).toBe('Got it');
      expect(sendArg.body).not.toContain('---------- Original Message ----------');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ replyToMessageId: 'nylas-msg-1' }),
        expect.stringContaining('failed to build reply quote'),
      );
    });

    it('registerOutboundContext receives original body, not quoted body', async () => {
      const ctx = makeCtx({
        reply_to_message_id: 'nylas-msg-1',
        body: 'My reply text',
        context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
      });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Discussion',
        body: '<p>Original content here</p>',
        date: 1700000000,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-1',
      });
      const mockRegister = vi.fn().mockResolvedValue('entry-1');
      (ctx as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
      };
      (ctx as Record<string, unknown>).agentId = 'coordinator';

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      // The quote is presentation — registerOutboundContext must see the agent's own words only
      expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({
        content: 'My reply text',
      }));
    });
  });

  describe('context_bridge', () => {
    it('registers a context bridge entry after successful reply', async () => {
      const ctx = makeCtx({
        reply_to_message_id: 'nylas-msg-1',
        body: 'Thanks for the update — any next steps?',
        context_bridge: JSON.stringify({
          agent_id: 'coordinator',
          expected_reply: 'Next steps or action items',
          expires_in_hours: 24,
        }),
      });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Project update',
        body: '',
        date: 0,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-1',
      });
      const mockRegister = vi.fn().mockResolvedValue('entry-1');
      (ctx as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
      };
      (ctx as Record<string, unknown>).agentId = 'coordinator';

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(mockRegister).toHaveBeenCalledWith({
        channelId: 'email',
        agentId: 'coordinator',
        content: 'Thanks for the update — any next steps?',
        expectedReply: 'Next steps or action items',
        expiresInHours: 24,
      });
    });

    it('registers a minimal entry when context_bridge is absent', async () => {
      const ctx = makeCtx({
        reply_to_message_id: 'nylas-msg-1',
        body: 'Got it, thanks',
      });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Quick note',
        body: '',
        date: 0,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-1',
      });
      const mockRegister = vi.fn().mockResolvedValue('entry-1');
      (ctx as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
      };
      (ctx as Record<string, unknown>).agentId = 'coordinator';

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(mockRegister).toHaveBeenCalledWith({
        channelId: 'email',
        agentId: 'coordinator',
        content: 'Got it, thanks',
        expiresInHours: 6,
      });
    });

    it('logs warning but succeeds when bridge registration fails', async () => {
      const ctx = makeCtx({
        reply_to_message_id: 'nylas-msg-1',
        body: 'Sounds good',
        context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
      });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Plan',
        body: '',
        date: 0,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-1',
      });
      const mockRegister = vi.fn().mockRejectedValue(new Error('DB error'));
      (ctx as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
      };
      (ctx as Record<string, unknown>).agentId = 'coordinator';

      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
    });
  });
});
