import { describe, it, expect, vi } from 'vitest';
import { EmailLabelHandler } from '../../../skills/email-label/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

describe('EmailLabelHandler', () => {
  const handler = new EmailLabelHandler();

  it('returns failure when message_id is missing', async () => {
    const result = await handler.execute(makeCtx({ labels: ['SECURITY'] }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('message_id');
  });

  it('returns failure when labels array is empty', async () => {
    const result = await handler.execute(makeCtx({ message_id: 'msg-1', labels: [] }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('labels');
  });

  it('returns failure when labels is not an array', async () => {
    const result = await handler.execute(makeCtx({ message_id: 'msg-1', labels: 'SECURITY' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('labels');
  });

  it('filters out non-string and empty labels', async () => {
    const result = await handler.execute(makeCtx({ message_id: 'msg-1', labels: [42, '', '  '] }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('labels');
  });

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(makeCtx({ message_id: 'msg-1', labels: ['SECURITY'] }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('applies labels successfully', async () => {
    const gateway = {
      labelEmailMessage: vi.fn().mockResolvedValue({
        success: true,
        applied: ['SECURITY'],
        created: [],
        folders: ['INBOX', 'folder-security-id'],
      }),
    };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', labels: ['SECURITY'] }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { message_id: string; applied: string[]; created: string[]; folders: string[] };
      expect(data.message_id).toBe('msg-1');
      expect(data.applied).toEqual(['SECURITY']);
      expect(data.created).toEqual([]);
    }
    expect(gateway.labelEmailMessage).toHaveBeenCalledWith('msg-1', ['SECURITY'], undefined);
  });

  it('passes accountId when account is provided', async () => {
    const gateway = {
      labelEmailMessage: vi.fn().mockResolvedValue({
        success: true,
        applied: ['SECURITY'],
        created: ['SECURITY'],
        folders: ['INBOX', 'folder-security-id'],
      }),
    };
    const result = await handler.execute(
      makeCtx(
        { message_id: 'msg-1', labels: ['SECURITY'], account: 'curia' },
        { outboundGateway: gateway as never },
      ),
    );
    expect(result.success).toBe(true);
    expect(gateway.labelEmailMessage).toHaveBeenCalledWith('msg-1', ['SECURITY'], 'curia');
  });

  it('returns failure when gateway returns an error', async () => {
    const gateway = {
      labelEmailMessage: vi.fn().mockResolvedValue({
        success: false,
        applied: [],
        created: [],
        folders: [],
        error: 'Nylas API error',
      }),
    };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', labels: ['SECURITY'] }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Nylas API error');
  });

  it('returns failure when gateway throws', async () => {
    const gateway = {
      labelEmailMessage: vi.fn().mockRejectedValue(new Error('Unexpected')),
    };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', labels: ['SECURITY'] }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(false);
  });

  it('trims whitespace from message_id and labels', async () => {
    const gateway = {
      labelEmailMessage: vi.fn().mockResolvedValue({
        success: true,
        applied: ['SECURITY'],
        created: [],
        folders: ['folder-id'],
      }),
    };
    const result = await handler.execute(
      makeCtx(
        { message_id: '  msg-1  ', labels: ['  SECURITY  '] },
        { outboundGateway: gateway as never },
      ),
    );
    expect(result.success).toBe(true);
    expect(gateway.labelEmailMessage).toHaveBeenCalledWith('msg-1', ['SECURITY'], undefined);
  });
});
