import { describe, it, expect, vi } from 'vitest';
import { AckPrincipalReportsHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { EntityMemory } from '../../../../src/memory/entity-memory.js';
import { createSilentLogger } from '../../../../src/logger.js';

const CURSOR = JSON.stringify({ t: '2026-10-18T14:00:00.000Z', id: 'b' });

function makeCtx(input: Record<string, unknown>, stored = true): ToolContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: createSilentLogger(),
    entityMemory: {
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      createEntity: vi.fn(),
      storeFact: vi.fn().mockResolvedValue({ stored, action: stored ? 'created' : 'rejected' }),
    } as unknown as EntityMemory,
  } as unknown as ToolContext;
}

describe('AckPrincipalReportsHandler', () => {
  it('stores the marker', async () => {
    const ctx = makeCtx({ cursor: CURSOR });

    const result = await new AckPrincipalReportsHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.entityMemory!.storeFact).toHaveBeenCalledWith(expect.objectContaining({
      label: 'last_reported',
      properties: expect.objectContaining({ value: CURSOR, namespace: 'reports' }),
    }));
  });

  it('reports a soft-rejected write as an error so the items repeat', async () => {
    const result = await new AckPrincipalReportsHandler().execute(makeCtx({ cursor: CURSOR }, false));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/repeat in the next digest/);
  });

  it('returns an error, not a throw, for a cursor it did not issue', async () => {
    const result = await new AckPrincipalReportsHandler().execute(makeCtx({ cursor: 'garbage' }));

    expect(result.success).toBe(false);
  });

  it('requires a cursor and entityMemory', async () => {
    const handler = new AckPrincipalReportsHandler();
    expect((await handler.execute(makeCtx({}))).success).toBe(false);
    expect((await handler.execute({ ...makeCtx({ cursor: CURSOR }), entityMemory: undefined } as ToolContext)).success).toBe(false);
  });
});
