import { describe, it, expect, vi } from 'vitest';
import { EmailArchiveHandler } from '../../../skills/email/tools/email-archive/handler.js';
import type { ToolContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<ToolContext>): ToolContext {
  return { toolName: 'email-archive', toolVersion: '1.0.0', input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
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
    expect(gateway.archiveEmailMessage).toHaveBeenCalledWith('msg-1', 'joseph', expect.anything());
  });

  it('passes undefined accountId when account is absent', async () => {
    const gateway = { archiveEmailMessage: vi.fn().mockResolvedValue({ success: true }) };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    expect(gateway.archiveEmailMessage).toHaveBeenCalledWith('msg-1', undefined, expect.anything());
  });

  it('passes undefined accountId when account is an empty string', async () => {
    const gateway = { archiveEmailMessage: vi.fn().mockResolvedValue({ success: true }) };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', account: '' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    expect(gateway.archiveEmailMessage).toHaveBeenCalledWith('msg-1', undefined, expect.anything());
  });

  // The two malformed IDs behind the prod 404s in #2083.
  it.each(['9b359f65-placeholder', '1a102a493eca2fc54'])(
    'rejects %s before calling the gateway',
    async (messageId) => {
      const gateway = { archiveEmailMessage: vi.fn() };
      const result = await handler.execute(
        makeCtx({ message_id: messageId }, { outboundGateway: gateway as never }),
      );
      expect(result).toMatchObject({ success: false, errorType: 'VALIDATION_ERROR' });
      if (!result.success) expect(result.error).toContain('is not a valid message ID');
      expect(gateway.archiveEmailMessage).not.toHaveBeenCalled();
    },
  );

  it("passes the gateway's NOT_FOUND through to the agent", async () => {
    const gateway = {
      archiveEmailMessage: vi.fn().mockResolvedValue({
        success: false,
        error: 'Message not found: … Do not retry with this ID.',
        errorType: 'NOT_FOUND',
      }),
    };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1' }, { outboundGateway: gateway as never }),
    );
    expect(result).toMatchObject({ success: false, errorType: 'NOT_FOUND' });
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
