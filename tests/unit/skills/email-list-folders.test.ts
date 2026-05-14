import { describe, it, expect, vi } from 'vitest';
import { EmailListFoldersHandler } from '../../../skills/email-list-folders/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

describe('EmailListFoldersHandler', () => {
  const handler = new EmailListFoldersHandler();

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('lists folders successfully', async () => {
    const gateway = {
      listEmailFolders: vi.fn().mockResolvedValue([
        { id: 'f1', name: 'INBOX' },
        { id: 'f2', name: 'SECURITY' },
      ]),
    };
    const result = await handler.execute(
      makeCtx({}, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { folders: Array<{ id: string; name: string }>; count: number };
      expect(data.count).toBe(2);
      expect(data.folders).toEqual([
        { id: 'f1', name: 'INBOX' },
        { id: 'f2', name: 'SECURITY' },
      ]);
    }
    expect(gateway.listEmailFolders).toHaveBeenCalledWith(undefined);
  });

  it('passes accountId when account is provided', async () => {
    const gateway = { listEmailFolders: vi.fn().mockResolvedValue([]) };
    await handler.execute(
      makeCtx({ account: 'curia' }, { outboundGateway: gateway as never }),
    );
    expect(gateway.listEmailFolders).toHaveBeenCalledWith('curia');
  });

  it('passes undefined accountId when account is empty string', async () => {
    const gateway = { listEmailFolders: vi.fn().mockResolvedValue([]) };
    await handler.execute(
      makeCtx({ account: '' }, { outboundGateway: gateway as never }),
    );
    expect(gateway.listEmailFolders).toHaveBeenCalledWith(undefined);
  });

  it('returns failure when gateway throws', async () => {
    const gateway = { listEmailFolders: vi.fn().mockRejectedValue(new Error('Nylas 500')) };
    const result = await handler.execute(
      makeCtx({}, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(false);
  });
});
