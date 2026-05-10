import { describe, it, expect, vi } from 'vitest';
import { EmailReplyHandler } from '../../../skills/email-reply/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  gateway?: Partial<{
    getEmailMessage: (...args: unknown[]) => unknown;
    send: (...args: unknown[]) => unknown;
  }>,
  taskMetadata?: Record<string, unknown>,
  opts?: { selfEmail?: string },
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    outboundGateway: gateway as never,
    taskMetadata,
    ...(opts?.selfEmail ? { selfEmail: opts.selfEmail } : {}),
  } as SkillContext;
}

describe('EmailReplyHandler', () => {
  const handler = new EmailReplyHandler();

  // --- Input validation ---

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(
      makeCtx({ reply_to_message_id: 'msg-1', body: 'Hello' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('returns failure when reply_to_message_id is missing', async () => {
    const gateway = { getEmailMessage: vi.fn(), send: vi.fn() };
    const result = await handler.execute(makeCtx({ body: 'Hello' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('reply_to_message_id');
  });

  it('returns failure when body is missing', async () => {
    const gateway = { getEmailMessage: vi.fn(), send: vi.fn() };
    const result = await handler.execute(
      makeCtx({ reply_to_message_id: 'msg-1' }, gateway),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('body');
  });

  it('returns failure when original message has no sender address', async () => {
    const gateway = {
      getEmailMessage: vi.fn().mockResolvedValue({ from: [], subject: 'Test' }),
      send: vi.fn(),
    };
    const result = await handler.execute(
      makeCtx({ reply_to_message_id: 'msg-1', body: 'Hello' }, gateway),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('no sender');
  });

  it('returns failure when gateway send is blocked', async () => {
    const gateway = {
      getEmailMessage: vi.fn().mockResolvedValue({
        from: [{ email: 's@example.com' }],
        subject: 'Test',
      }),
      send: vi.fn().mockResolvedValue({ success: false, blockedReason: 'Recipient blocked' }),
    };
    const result = await handler.execute(
      makeCtx({ reply_to_message_id: 'msg-1', body: 'Hello' }, gateway),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('blocked');
  });

  it('returns message_id, to, and subject on success', async () => {
    const gateway = {
      getEmailMessage: vi.fn().mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        subject: 'Meeting',
      }),
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-42' }),
    };
    const result = await handler.execute(
      makeCtx({ reply_to_message_id: 'msg-orig', body: 'Confirmed!' }, gateway),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { message_id: string; to: string; subject: string };
      expect(data.message_id).toBe('sent-42');
      expect(data.to).toBe('alice@example.com');
      expect(data.subject).toBe('Re: Meeting');
    }
  });

  it('strips existing Re: prefix before adding Re:', async () => {
    const gateway = {
      getEmailMessage: vi.fn().mockResolvedValue({
        from: [{ email: 's@example.com' }],
        subject: 'Re: Something',
      }),
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-43' }),
    };
    const result = await handler.execute(
      makeCtx({ reply_to_message_id: 'msg-1', body: 'Got it' }, gateway),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { subject: string }).subject).toBe('Re: Something');
    }
  });
});

// ---------------------------------------------------------------------------
// CC modes — reply-all, reply-to-sender, explicit CC list
// ---------------------------------------------------------------------------

describe('EmailReplyHandler — CC modes', () => {
  const handler = new EmailReplyHandler();

  /** Delegates to makeCtx with selfEmail support. */
  function makeCtxWithSelf(
    input: Record<string, unknown>,
    gateway: Partial<{
      getEmailMessage: (...args: unknown[]) => unknown;
      send: (...args: unknown[]) => unknown;
    }>,
    selfEmail?: string,
  ): SkillContext {
    return makeCtx(input, gateway, {}, { selfEmail });
  }

  it('cc absent (undefined) — auto-populates from original to/cc, excluding primary To and selfEmail', async () => {
    const gateway = {
      getEmailMessage: vi.fn().mockResolvedValue({
        from: [{ email: 'sender@example.com' }],
        to: [{ email: 'curia@example.com' }, { email: 'bob@example.com' }],
        cc: [{ email: 'carol@example.com' }],
        subject: 'Group thread',
      }),
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-cc-1' }),
    };

    // cc is NOT in the input — triggers reply-all mode
    const result = await handler.execute(
      makeCtxWithSelf(
        { reply_to_message_id: 'msg-group', body: 'Sounds good' },
        gateway,
        'curia@example.com',
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { message_id: string; to: string; subject: string; cc: string };
      expect(data.message_id).toBe('sent-cc-1');
      expect(data.to).toBe('sender@example.com');
      expect(data.subject).toBe('Re: Group thread');
      // sender@example.com is excluded (primary To recipient), curia@example.com is excluded (selfEmail)
      // bob@example.com and carol@example.com remain
      expect(data.cc).toBe('bob@example.com, carol@example.com');
    }

    // Verify the send call received the CC array
    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({
        cc: ['bob@example.com', 'carol@example.com'],
      }),
    );
  });

  it('cc === "" — reply to sender only, no CC', async () => {
    const gateway = {
      getEmailMessage: vi.fn().mockResolvedValue({
        from: [{ email: 'sender@example.com' }],
        to: [{ email: 'curia@example.com' }, { email: 'bob@example.com' }],
        cc: [{ email: 'carol@example.com' }],
        subject: 'Group thread',
      }),
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-cc-2' }),
    };

    // cc is explicitly empty string — reply to sender only
    const result = await handler.execute(
      makeCtxWithSelf(
        { reply_to_message_id: 'msg-group', body: 'Private reply', cc: '' },
        gateway,
        'curia@example.com',
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { message_id: string; to: string; subject: string; cc: string };
      expect(data.message_id).toBe('sent-cc-2');
      expect(data.to).toBe('sender@example.com');
      expect(data.subject).toBe('Re: Group thread');
      expect(data.cc).toBe('');
    }

    // Verify the send call does NOT include a cc property
    const sendArg = (gateway.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sendArg).not.toHaveProperty('cc');
  });

  it('cc is explicit comma-separated list — used as-is', async () => {
    const gateway = {
      getEmailMessage: vi.fn().mockResolvedValue({
        from: [{ email: 'sender@example.com' }],
        to: [{ email: 'curia@example.com' }],
        cc: [],
        subject: 'Forwarded',
      }),
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-cc-3' }),
    };

    // Explicit CC list overrides all auto-population logic
    const result = await handler.execute(
      makeCtxWithSelf(
        { reply_to_message_id: 'msg-fwd', body: 'Adding you both', cc: 'a@example.com,b@example.com' },
        gateway,
        'curia@example.com',
      ),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { message_id: string; to: string; subject: string; cc: string };
      expect(data.message_id).toBe('sent-cc-3');
      expect(data.to).toBe('sender@example.com');
      expect(data.subject).toBe('Re: Forwarded');
      // join(', ') produces a space after each comma
      expect(data.cc).toBe('a@example.com, b@example.com');
    }

    // Verify the send call received the explicit CC array
    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({
        cc: ['a@example.com', 'b@example.com'],
      }),
    );
  });
});
