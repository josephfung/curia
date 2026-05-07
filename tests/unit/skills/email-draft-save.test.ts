import { describe, it, expect, vi } from 'vitest';
import { EmailDraftSaveHandler } from '../../../skills/email-draft-save/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, gateway?: Partial<{
  createEmailDraft: (...args: unknown[]) => unknown;
}>, taskMetadata?: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    outboundGateway: gateway as never,
    taskMetadata,
  };
}

describe('EmailDraftSaveHandler', () => {
  const handler = new EmailDraftSaveHandler();

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi', body: 'Hello' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('returns failure when to is missing', async () => {
    const gateway = { createEmailDraft: vi.fn() };
    const result = await handler.execute(makeCtx({ subject: 'Hi', body: 'Hello' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('to');
  });

  it('returns failure when subject is missing', async () => {
    const gateway = { createEmailDraft: vi.fn() };
    const result = await handler.execute(makeCtx({ to: 'r@example.com', body: 'Hello' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('subject');
  });

  it('returns failure when body is missing', async () => {
    const gateway = { createEmailDraft: vi.fn() };
    const result = await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('body');
  });

  it('calls createEmailDraft with channel: email and correct fields', async () => {
    const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'draft-1' }) };
    await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi', body: 'Hello' }, gateway));
    expect(gateway.createEmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', to: 'r@example.com', subject: 'Hi', body: 'Hello' }),
    );
  });

  it('passes account as accountId', async () => {
    const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'd-1' }) };
    await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi', body: 'Hello', account: 'joseph' }, gateway));
    expect(gateway.createEmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'joseph' }),
    );
  });

  it('passes reply_to_message_id as replyToMessageId', async () => {
    const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'd-1' }) };
    await handler.execute(makeCtx(
      { to: 'r@example.com', subject: 'Re: Hi', body: 'Hello', reply_to_message_id: 'msg-orig' },
      gateway,
    ));
    expect(gateway.createEmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: 'msg-orig' }),
    );
  });

  it('returns draft_id on success', async () => {
    const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'draft-99' }) };
    const result = await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi', body: 'Hello' }, gateway));
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { draft_id: string }).draft_id).toBe('draft-99');
    }
  });

  it('returns failure when gateway returns success: false (blocked recipient)', async () => {
    const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: false, blockedReason: 'Recipient is blocked' }) };
    const result = await handler.execute(makeCtx({ to: 'blocked@example.com', subject: 'Hi', body: 'Hello' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('blocked');
  });

  it('returns failure when gateway throws unexpectedly', async () => {
    const gateway = { createEmailDraft: vi.fn().mockRejectedValue(new Error('Nylas timeout')) };
    const result = await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi', body: 'Hello' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Failed to save draft');
  });

  describe('missing-account warning for drafts', () => {
    it('logs a warning when account is omitted', async () => {
      const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'd-1' }) };
      const warnSpy = vi.fn();
      const ctx = makeCtx(
        { to: 'r@example.com', subject: 'Hi', body: 'Hello' },
        gateway,
      );
      // Override the warn method to capture the call
      ctx.log = { ...logger, warn: warnSpy } as never;
      await handler.execute(ctx);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'r@example.com', subject: 'Hi' }),
        expect.stringContaining('no account specified'),
      );
    });

    it('does not warn when account is provided', async () => {
      const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'd-1' }) };
      const warnSpy = vi.fn();
      const ctx = makeCtx(
        { to: 'r@example.com', subject: 'Hi', body: 'Hello', account: 'ceo-account' },
        gateway,
      );
      ctx.log = { ...logger, warn: warnSpy } as never;
      await handler.execute(ctx);
      expect(warnSpy).not.toHaveBeenCalled();
    });

  });
});
