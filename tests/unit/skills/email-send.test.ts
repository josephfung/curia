import { describe, it, expect, vi } from 'vitest';
import { EmailSendHandler } from '../../../skills/email-send/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  gateway?: Partial<{
    send: (...args: unknown[]) => unknown;
    getEmailMessage: (...args: unknown[]) => unknown;
  }>,
  opts?: { timezone?: string; agentId?: string },
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    outboundGateway: gateway as never,
    outboundContext: undefined,
    timezone: opts?.timezone,
    agentId: opts?.agentId,
  } as SkillContext;
}

const originalMessage = {
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  to: [{ email: 'ceo@example.com' }],
  date: 1700000000,
  subject: 'Q2 planning',
  body: '<p>Let me know your thoughts.</p>',
};

describe('EmailSendHandler — reply quote', () => {
  const handler = new EmailSendHandler();

  it('appends quote and passes replyToMessageId when reply_to_message_id is set', async () => {
    const gateway = {
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-1' }),
      getEmailMessage: vi.fn().mockResolvedValue(originalMessage),
    };
    const result = await handler.execute(makeCtx(
      { to: 'alice@example.com', subject: 'Re: Q2 planning', body: 'Sounds good!', reply_to_message_id: 'msg-orig' },
      gateway,
      { timezone: 'America/Toronto' },
    ));

    expect(result.success).toBe(true);
    expect(gateway.getEmailMessage).toHaveBeenCalledWith('msg-orig');

    const sendArg = gateway.send.mock.calls[0]![0] as { body: string; htmlQuote?: string; replyToMessageId?: string };
    // Reply body stays as markdown; gateway converts it to HTML
    expect(sendArg.body).toContain('Sounds good!');
    // HTML quote passed separately so markdownToHtml does not re-escape it
    expect(sendArg.htmlQuote).toContain('<blockquote');
    expect(sendArg.htmlQuote).toContain('alice@example.com');
    expect(sendArg.htmlQuote).toContain('Let me know your thoughts.');
    expect(sendArg.replyToMessageId).toBe('msg-orig');
  });

  it('does not fetch original or append quote when reply_to_message_id is absent', async () => {
    const gateway = {
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-2' }),
      getEmailMessage: vi.fn(),
    };
    const result = await handler.execute(makeCtx(
      { to: 'alice@example.com', subject: 'Hello', body: 'Hi there' },
      gateway,
    ));

    expect(result.success).toBe(true);
    expect(gateway.getEmailMessage).not.toHaveBeenCalled();

    const sendArg = gateway.send.mock.calls[0]![0] as { body: string; replyToMessageId?: string };
    expect(sendArg.body).toBe('Hi there');
    expect(sendArg.replyToMessageId).toBeUndefined();
  });

  it('proceeds without quote when getEmailMessage fails', async () => {
    const gateway = {
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-3' }),
      getEmailMessage: vi.fn().mockRejectedValue(new Error('Not found')),
    };
    const warnSpy = vi.fn();
    const ctx = makeCtx(
      { to: 'alice@example.com', subject: 'Re: Q2', body: 'Got it', reply_to_message_id: 'msg-missing' },
      gateway,
    );
    ctx.log = { ...logger, warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);

    const sendArg = gateway.send.mock.calls[0]![0] as { body: string; replyToMessageId?: string };
    // Body should be unquoted
    expect(sendArg.body).toBe('Got it');
    expect(sendArg.body).not.toContain('---------- Original Message ----------');
    // replyToMessageId still passed for threading
    expect(sendArg.replyToMessageId).toBe('msg-missing');
    // Warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: 'msg-missing' }),
      expect.stringContaining('failed to fetch original message'),
    );
  });
});
