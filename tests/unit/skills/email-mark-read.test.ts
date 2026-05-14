import { describe, it, expect, vi } from 'vitest';
import { EmailMarkReadHandler } from '../../../skills/email-mark-read/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

describe('EmailMarkReadHandler', () => {
  const handler = new EmailMarkReadHandler();

  it('returns failure when message_id is missing', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('message_id');
  });

  it('returns failure when message_id is not a string', async () => {
    const result = await handler.execute(makeCtx({ message_id: 42 }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('message_id');
  });

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(makeCtx({ message_id: 'msg-1' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('marks as read successfully and returns { marked_read: true }', async () => {
    const gateway = { markEmailAsRead: vi.fn().mockResolvedValue({ success: true }) };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', account: 'curia' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as { marked_read: boolean }).marked_read).toBe(true);
    expect(gateway.markEmailAsRead).toHaveBeenCalledWith('msg-1', 'curia');
  });

  it('passes undefined accountId when account is absent', async () => {
    const gateway = { markEmailAsRead: vi.fn().mockResolvedValue({ success: true }) };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    expect(gateway.markEmailAsRead).toHaveBeenCalledWith('msg-1', undefined);
  });

  it('passes undefined accountId when account is empty string', async () => {
    const gateway = { markEmailAsRead: vi.fn().mockResolvedValue({ success: true }) };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', account: '' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    expect(gateway.markEmailAsRead).toHaveBeenCalledWith('msg-1', undefined);
  });

  it('returns failure when gateway returns an error', async () => {
    const gateway = {
      markEmailAsRead: vi.fn().mockResolvedValue({ success: false, error: 'Nylas 503' }),
    };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Nylas 503');
  });

  it('returns failure when gateway throws', async () => {
    const gateway = {
      markEmailAsRead: vi.fn().mockRejectedValue(new Error('Unexpected')),
    };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(false);
  });
});
