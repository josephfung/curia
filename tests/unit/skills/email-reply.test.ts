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
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    outboundGateway: gateway as never,
    taskMetadata,
  };
}

describe('EmailReplyHandler', () => {
  const handler = new EmailReplyHandler();

  // --- Observation mode block ---

  it('blocks in observation mode and does not call gateway', async () => {
    const gateway = { getEmailMessage: vi.fn(), send: vi.fn() };
    const result = await handler.execute(
      makeCtx(
        { reply_to_message_id: 'msg-1', body: 'Hello' },
        gateway,
        { observationMode: true },
      ),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/observation mode/i);
      // Verify the error redirects callers to the correct alternative
      expect(result.error).toMatch(/email-draft-save/i);
    }
    expect(gateway.getEmailMessage).not.toHaveBeenCalled();
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it('does not block when observationMode is false', async () => {
    const gateway = {
      getEmailMessage: vi.fn().mockResolvedValue({
        from: [{ email: 'sender@example.com' }],
        subject: 'Test',
      }),
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-out-1' }),
    };
    const result = await handler.execute(
      makeCtx(
        { reply_to_message_id: 'msg-1', body: 'Hello' },
        gateway,
        { observationMode: false },
      ),
    );
    expect(result.success).toBe(true);
  });

  it('does not block when taskMetadata is absent', async () => {
    const gateway = {
      getEmailMessage: vi.fn().mockResolvedValue({
        from: [{ email: 'sender@example.com' }],
        subject: 'Test',
      }),
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-out-2' }),
    };
    const result = await handler.execute(
      makeCtx({ reply_to_message_id: 'msg-1', body: 'Hello' }, gateway),
    );
    expect(result.success).toBe(true);
  });

  // --- Input validation (non-obs-mode) ---

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
