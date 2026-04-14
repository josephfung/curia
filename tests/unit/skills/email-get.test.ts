import { describe, it, expect, vi } from 'vitest';
import { EmailGetHandler } from '../../../skills/email-get/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const mockMessage = {
  id: 'msg-1',
  threadId: 'thread-1',
  subject: 'Hello',
  from: [{ email: 'sender@example.com', name: 'Sender' }],
  to: [{ email: 'ceo@example.com' }],
  cc: [],
  bcc: [],
  body: '<p>Full body here</p>',
  snippet: 'Full body here',
  date: 1700000000,
  unread: true,
  folders: ['INBOX'],
};

function makeCtx(input: Record<string, unknown>, gateway?: Partial<{
  getEmailMessage: (...args: unknown[]) => unknown;
}>): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    outboundGateway: gateway as never,
  };
}

describe('EmailGetHandler', () => {
  const handler = new EmailGetHandler();

  it('returns failure when message_id is missing', async () => {
    const gateway = { getEmailMessage: vi.fn() };
    const result = await handler.execute(makeCtx({}, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('message_id');
  });

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(makeCtx({ message_id: 'msg-1' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('fetches message using default (primary) account when account is omitted', async () => {
    const gateway = { getEmailMessage: vi.fn().mockResolvedValue(mockMessage) };
    const result = await handler.execute(makeCtx({ message_id: 'msg-1' }, gateway));
    expect(result.success).toBe(true);
    expect(gateway.getEmailMessage).toHaveBeenCalledWith('msg-1', undefined);
  });

  it('passes account as accountId when provided', async () => {
    const gateway = { getEmailMessage: vi.fn().mockResolvedValue(mockMessage) };
    await handler.execute(makeCtx({ message_id: 'msg-1', account: 'joseph' }, gateway));
    expect(gateway.getEmailMessage).toHaveBeenCalledWith('msg-1', 'joseph');
  });

  it('trims whitespace from message_id', async () => {
    const gateway = { getEmailMessage: vi.fn().mockResolvedValue(mockMessage) };
    await handler.execute(makeCtx({ message_id: '  msg-1  ' }, gateway));
    expect(gateway.getEmailMessage).toHaveBeenCalledWith('msg-1', undefined);
  });

  it('returns the full message including body', async () => {
    const gateway = { getEmailMessage: vi.fn().mockResolvedValue(mockMessage) };
    const result = await handler.execute(makeCtx({ message_id: 'msg-1' }, gateway));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { message: { id: string; body: string } };
      expect(data.message.id).toBe('msg-1');
      expect(data.message.body).toBe('<p>Full body here</p>');
    }
  });

  it('returns failure when gateway throws (message not found)', async () => {
    const gateway = { getEmailMessage: vi.fn().mockRejectedValue(new Error('Nylas 404')) };
    const result = await handler.execute(makeCtx({ message_id: 'msg-missing' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Failed to fetch');
  });
});
