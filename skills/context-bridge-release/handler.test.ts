import { describe, it, expect, vi } from 'vitest';
import { ContextBridgeReleaseHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import pino from 'pino';

const handler = new ContextBridgeReleaseHandler();

function makeCtx(input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: vi.fn((name: string) => { throw new Error(`Missing secret: ${name}`); }),
    log: pino({ level: 'silent' }),
    outboundContext: {
      register: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as SkillContext;
}

describe('ContextBridgeReleaseHandler', () => {
  it('calls release with the provided entry_id', async () => {
    const ctx = makeCtx({ entry_id: 'abc-123' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.outboundContext!.release).toHaveBeenCalledWith('abc-123');
  });

  it('returns error when entry_id is missing', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/entry_id/);
    }
  });

  it('returns error when outboundContext capability is missing', async () => {
    const ctx = makeCtx({ entry_id: 'abc-123' });
    (ctx as unknown as Record<string, unknown>).outboundContext = undefined;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/outboundContext/);
    }
  });

  it('returns error when release throws', async () => {
    const ctx = makeCtx({ entry_id: 'abc-123' });
    (ctx.outboundContext!.release as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB error'),
    );

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Failed to release/);
    }
  });
});
