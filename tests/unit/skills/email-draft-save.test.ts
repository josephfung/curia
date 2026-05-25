import { describe, it, expect, vi } from 'vitest';
import { EmailDraftSaveHandler } from '../../../skills/email-draft-save/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, gateway?: Partial<{
  createEmailDraft: (...args: unknown[]) => unknown;
  getEmailMessage: (...args: unknown[]) => unknown;
}>, taskMetadata?: Record<string, unknown>, opts?: { timezone?: string }): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    outboundGateway: gateway as never,
    taskMetadata,
    timezone: opts?.timezone,
  } as SkillContext;
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
    const gateway = {
      createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'd-1' }),
      getEmailMessage: vi.fn().mockResolvedValue({
        from: [{ email: 'sender@example.com' }],
        to: [{ email: 'r@example.com' }],
        date: 1700000000,
        subject: 'Hi',
        body: '<p>Original</p>',
      }),
    };
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

  describe('reply quote', () => {
    const originalMessage = {
      from: [{ name: 'Alice', email: 'alice@example.com' }],
      to: [{ email: 'ceo@example.com' }],
      date: 1700000000,
      subject: 'Q2 planning',
      body: '<p>Let me know your thoughts.</p>',
    };

    it('appends quote when reply_to_message_id is present', async () => {
      const gateway = {
        createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'd-q1' }),
        getEmailMessage: vi.fn().mockResolvedValue(originalMessage),
      };
      await handler.execute(makeCtx(
        { to: 'alice@example.com', subject: 'Re: Q2 planning', body: 'Sounds good!', reply_to_message_id: 'msg-orig' },
        gateway,
        {},
        { timezone: 'America/Toronto' },
      ));
      expect(gateway.getEmailMessage).toHaveBeenCalledWith('msg-orig', undefined);
      const callBody = (gateway.createEmailDraft.mock.calls[0]! as [{ body: string }])[0].body;
      expect(callBody).toContain('Sounds good!');
      expect(callBody).toContain('---------- Original Message ----------');
      expect(callBody).toContain('Alice <alice@example.com>');
      expect(callBody).toContain('Let me know your thoughts.');
    });

    it('does not fetch original or append quote when reply_to_message_id is absent', async () => {
      const gateway = {
        createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'd-q2' }),
        getEmailMessage: vi.fn(),
      };
      await handler.execute(makeCtx(
        { to: 'r@example.com', subject: 'Hi', body: 'Hello' },
        gateway,
      ));
      expect(gateway.getEmailMessage).not.toHaveBeenCalled();
      const callBody = (gateway.createEmailDraft.mock.calls[0]! as [{ body: string }])[0].body;
      expect(callBody).toBe('Hello');
    });

    it('proceeds without quote when getEmailMessage fails', async () => {
      const gateway = {
        createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'd-q3' }),
        getEmailMessage: vi.fn().mockRejectedValue(new Error('Not found')),
      };
      const warnSpy = vi.fn();
      const ctx = makeCtx(
        { to: 'r@example.com', subject: 'Re: Hi', body: 'Got it', reply_to_message_id: 'msg-missing' },
        gateway,
      );
      ctx.log = { ...logger, warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      // Body should be unquoted
      const callBody = (gateway.createEmailDraft.mock.calls[0]! as [{ body: string }])[0].body;
      expect(callBody).toBe('Got it');
      expect(callBody).not.toContain('---------- Original Message ----------');
      // Warning was logged
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ replyToMessageId: 'msg-missing' }),
        expect.stringContaining('failed to fetch original message'),
      );
    });

    it('passes accountId to getEmailMessage', async () => {
      const gateway = {
        createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'd-q4' }),
        getEmailMessage: vi.fn().mockResolvedValue(originalMessage),
      };
      await handler.execute(makeCtx(
        { to: 'alice@example.com', subject: 'Re: Q2', body: 'OK', reply_to_message_id: 'msg-acct', account: 'ceo-acct' },
        gateway,
      ));
      expect(gateway.getEmailMessage).toHaveBeenCalledWith('msg-acct', 'ceo-acct');
    });
  });
});
