import { describe, it, expect, vi } from 'vitest';
import { ContextBridgeClearHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import pino from 'pino';

const handler = new ContextBridgeClearHandler();

function makeCtx(
  input: Record<string, unknown>,
  clearResult: unknown = { totalReleased: 0, perSubject: [], unmatched: [] },
): ToolContext {
  return {
    input,
    secret: vi.fn((name: string) => { throw new Error(`Missing secret: ${name}`); }),
    log: pino({ level: 'silent' }),
    outboundContext: {
      register: vi.fn(),
      release: vi.fn(),
      clearBySubjects: vi.fn().mockResolvedValue(clearResult),
    },
  } as unknown as ToolContext;
}

describe('ContextBridgeClearHandler', () => {
  it('clears by a subjects array and returns the actual released set', async () => {
    const ctx = makeCtx({ subjects: ['Sean Brownlee', 'Khanjan Desai'] }, {
      totalReleased: 6,
      perSubject: [
        { subject: 'Sean Brownlee', released: 4 },
        { subject: 'Khanjan Desai', released: 2 },
      ],
      unmatched: [],
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.outboundContext!.clearBySubjects).toHaveBeenCalledWith(['Sean Brownlee', 'Khanjan Desai']);
    if (result.success) {
      expect(result.data).toEqual({
        released: 6,
        cleared: [
          { subject: 'Sean Brownlee', count: 4 },
          { subject: 'Khanjan Desai', count: 2 },
        ],
        unmatched: [],
      });
    }
  });

  it('accepts a single subject string', async () => {
    const ctx = makeCtx({ subject: 'Peter Lenardon' }, {
      totalReleased: 2,
      perSubject: [{ subject: 'Peter Lenardon', released: 2 }],
      unmatched: [],
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.outboundContext!.clearBySubjects).toHaveBeenCalledWith(['Peter Lenardon']);
  });

  it('falls back to subject when subjects is an empty array', async () => {
    // An empty `subjects` array must not shadow a valid single `subject`.
    const ctx = makeCtx({ subjects: [], subject: 'Peter Lenardon' }, {
      totalReleased: 2,
      perSubject: [{ subject: 'Peter Lenardon', released: 2 }],
      unmatched: [],
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.outboundContext!.clearBySubjects).toHaveBeenCalledWith(['Peter Lenardon']);
  });

  it('surfaces unmatched subjects in the result', async () => {
    const ctx = makeCtx({ subjects: ['Walk and Ice cream', 'Ghost Meeting'] }, {
      totalReleased: 3,
      perSubject: [{ subject: 'Walk and Ice cream', released: 3 }],
      unmatched: ['Ghost Meeting'],
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { unmatched: string[] }).unmatched).toEqual(['Ghost Meeting']);
    }
  });

  it('returns an error when no subjects are provided', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/subjects/);
  });

  it('returns an error when all subjects are blank', async () => {
    const ctx = makeCtx({ subjects: ['', '  '] });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('returns an error when outboundContext capability is missing', async () => {
    const ctx = makeCtx({ subjects: ['Sean Brownlee'] });
    (ctx as unknown as Record<string, unknown>).outboundContext = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundContext/);
  });

  it('returns an error when clearBySubjects throws', async () => {
    const ctx = makeCtx({ subjects: ['Sean Brownlee'] });
    (ctx.outboundContext!.clearBySubjects as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Failed to clear/);
  });

  // #2261: it releases by subject across every entry, so a contact's turn cannot use it.
  it('refuses a turn an outside contact started, releasing nothing', async () => {
    const ctx = makeCtx({ subjects: ['Jeff Henry board seat'] }, { totalReleased: 2, perSubject: [], unmatched: [] });
    (ctx as unknown as Record<string, unknown>).taskMetadata = {
      originator: { contactId: '1d833dd7-5c5f-4adc-b311-c8347b49a18e', systemRole: null, channel: 'signal', initiatedAt: '2026-10-21T21:29:59.973Z', tier: 'trusted' },
    };
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect(ctx.outboundContext!.clearBySubjects).not.toHaveBeenCalled();
  });

  it('still clears on a principal turn', async () => {
    const ctx = makeCtx({ subjects: ['Sean Brownlee'] }, { totalReleased: 1, perSubject: [{ subject: 'Sean Brownlee', released: 1 }], unmatched: [] });
    (ctx as unknown as Record<string, unknown>).taskMetadata = {
      originator: { contactId: 'principal-1', systemRole: 'principal', channel: 'signal', initiatedAt: '2026-10-21T21:29:59.973Z', tier: null },
    };
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
  });
});
