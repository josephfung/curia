import { describe, it, expect, vi } from 'vitest';
import { EmailCreateFolderHandler } from '../../../skills/email-create-folder/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

describe('EmailCreateFolderHandler', () => {
  const handler = new EmailCreateFolderHandler();

  it('returns failure when name is missing', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('name');
  });

  it('returns failure when name is not a string', async () => {
    const result = await handler.execute(makeCtx({ name: 42 }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('name');
  });

  it('returns failure when name is empty after trimming', async () => {
    const result = await handler.execute(makeCtx({ name: '   ' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('name');
  });

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(makeCtx({ name: 'SECURITY' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('creates a folder successfully', async () => {
    const gateway = {
      createEmailFolder: vi.fn().mockResolvedValue({ id: 'folder-new', name: 'SECURITY' }),
    };
    const result = await handler.execute(
      makeCtx({ name: 'SECURITY' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { id: string; name: string };
      expect(data.id).toBe('folder-new');
      expect(data.name).toBe('SECURITY');
    }
    expect(gateway.createEmailFolder).toHaveBeenCalledWith('SECURITY', undefined);
  });

  it('passes accountId when account is provided', async () => {
    const gateway = {
      createEmailFolder: vi.fn().mockResolvedValue({ id: 'f1', name: 'TEST' }),
    };
    await handler.execute(
      makeCtx({ name: 'TEST', account: 'curia' }, { outboundGateway: gateway as never }),
    );
    expect(gateway.createEmailFolder).toHaveBeenCalledWith('TEST', 'curia');
  });

  it('trims whitespace from name', async () => {
    const gateway = {
      createEmailFolder: vi.fn().mockResolvedValue({ id: 'f1', name: 'SECURITY' }),
    };
    await handler.execute(
      makeCtx({ name: '  SECURITY  ' }, { outboundGateway: gateway as never }),
    );
    expect(gateway.createEmailFolder).toHaveBeenCalledWith('SECURITY', undefined);
  });

  it('returns failure when gateway throws', async () => {
    const gateway = {
      createEmailFolder: vi.fn().mockRejectedValue(new Error('Nylas 409')),
    };
    const result = await handler.execute(
      makeCtx({ name: 'SECURITY' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(false);
  });
});
