import { describe, it, expect, vi } from 'vitest';
import { EmailListHandler } from '../../../skills/email-list/handler.js';
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
  body: 'Full body here',
  snippet: 'Hello...',
  date: 1700000000,
  unread: true,
  folders: ['INBOX'],
};

function makeCtx(input: Record<string, unknown>, gateway?: Partial<{
  listEmailMessages: (...args: unknown[]) => unknown;
}>): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    outboundGateway: gateway as never,
  };
}

describe('EmailListHandler', () => {
  const handler = new EmailListHandler();

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('returns failure when gateway throws (no client configured)', async () => {
    const gateway = { listEmailMessages: vi.fn().mockRejectedValue(new Error('no nylasClient is configured')) };
    const result = await handler.execute(makeCtx({}, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Failed to list');
  });

  it('calls listEmailMessages with no options when no params given', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    const result = await handler.execute(makeCtx({}, gateway));
    expect(result.success).toBe(true);
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }), undefined);
  });

  it('passes account param as accountId', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ account: 'joseph' }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(expect.anything(), 'joseph');
  });

  it('passes folder param as folders array', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ folder: 'DRAFTS' }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(
      expect.objectContaining({ folders: ['DRAFTS'] }),
      undefined,
    );
  });

  it('passes unread_only as unread option', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ unread_only: true }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(
      expect.objectContaining({ unread: true }),
      undefined,
    );
  });

  it('passes from filter', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ from: 'boss@example.com' }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'boss@example.com' }),
      undefined,
    );
  });

  it('passes search as searchQueryNative', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ search: 'in:inbox is:unread' }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(
      expect.objectContaining({ searchQueryNative: 'in:inbox is:unread' }),
      undefined,
    );
  });

  it('caps limit at 50 and passes it through', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ limit: 200 }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
      undefined,
    );
  });

  it('returns normalised messages array with count', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([mockMessage]) };
    const result = await handler.execute(makeCtx({}, gateway));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { messages: unknown[]; count: number };
      expect(data.messages).toHaveLength(1);
      expect(data.count).toBe(1);
    }
  });

  it('omits body from listed messages (snippet only)', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([mockMessage]) };
    const result = await handler.execute(makeCtx({}, gateway));
    expect(result.success).toBe(true);
    if (result.success) {
      const messages = (result.data as { messages: Record<string, unknown>[] }).messages;
      expect(messages[0]).not.toHaveProperty('body');
      expect(messages[0]).toHaveProperty('snippet');
    }
  });
});
