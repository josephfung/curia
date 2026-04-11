import { describe, it, expect, vi } from 'vitest';
import { EmailArchiveHandler } from '../../../skills/email-archive/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

describe('EmailArchiveHandler', () => {
  const handler = new EmailArchiveHandler();

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

  it('archives successfully and returns { archived: true }', async () => {
    const gateway = { archiveEmailMessage: vi.fn().mockResolvedValue({ success: true }) };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', account: 'joseph' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as { archived: boolean }).archived).toBe(true);
    expect(gateway.archiveEmailMessage).toHaveBeenCalledWith('msg-1', 'joseph');
  });

  it('passes undefined accountId when account is absent', async () => {
    const gateway = { archiveEmailMessage: vi.fn().mockResolvedValue({ success: true }) };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    expect(gateway.archiveEmailMessage).toHaveBeenCalledWith('msg-1', undefined);
  });

  it('passes undefined accountId when account is an empty string', async () => {
    const gateway = { archiveEmailMessage: vi.fn().mockResolvedValue({ success: true }) };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', account: '' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    expect(gateway.archiveEmailMessage).toHaveBeenCalledWith('msg-1', undefined);
  });

  it('returns failure when gateway returns an error', async () => {
    const gateway = {
      archiveEmailMessage: vi.fn().mockResolvedValue({ success: false, error: 'Nylas 503' }),
    };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Nylas 503');
  });
});
