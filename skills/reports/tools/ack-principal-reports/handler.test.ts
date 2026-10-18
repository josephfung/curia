import { describe, it, expect, vi } from 'vitest';
import { AckPrincipalReportsHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { AuditLogRepo } from '../../../../src/audit/audit-log-repo.js';
import type { EntityMemory } from '../../../../src/memory/entity-memory.js';
import { createSilentLogger } from '../../../../src/logger.js';

function makeCtx(input: Record<string, unknown>, opts: { stored?: boolean; exists?: boolean; storeThrows?: boolean } = {}): ToolContext {
  const { stored = true, exists = true, storeThrows = false } = opts;
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: createSilentLogger(),
    auditLogRepo: { hasEventAtSeq: vi.fn().mockResolvedValue(exists) } as unknown as AuditLogRepo,
    entityMemory: {
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      createEntity: vi.fn(),
      storeFact: storeThrows
        ? vi.fn().mockRejectedValue(new Error('kg down'))
        : vi.fn().mockResolvedValue({ stored, action: stored ? 'created' : 'rejected' }),
    } as unknown as EntityMemory,
  } as unknown as ToolContext;
}

describe('AckPrincipalReportsHandler', () => {
  it('stores the marker', async () => {
    const ctx = makeCtx({ cursor: '14' });

    const result = await new AckPrincipalReportsHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.entityMemory!.storeFact).toHaveBeenCalledWith(expect.objectContaining({
      label: 'last_reported',
      properties: expect.objectContaining({ value: '14', namespace: 'reports' }),
    }));
  });

  it('reports a soft-rejected write as an error so the items repeat', async () => {
    const result = await new AckPrincipalReportsHandler().execute(makeCtx({ cursor: '14' }, { stored: false }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/repeat in the next digest/);
  });

  it('rejects a cursor list-principal-reports did not issue', async () => {
    const handler = new AckPrincipalReportsHandler();
    const malformed = await handler.execute(makeCtx({ cursor: 'garbage' }));
    const unknown = await handler.execute(makeCtx({ cursor: '999999' }, { exists: false }));

    for (const result of [malformed, unknown]) {
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toMatch(/not issued by list-principal-reports/);
    }
  });

  it('reports a storage failure as such, not as a bad cursor', async () => {
    const result = await new AckPrincipalReportsHandler().execute(makeCtx({ cursor: '14' }, { storeThrows: true }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/could not be stored/);
  });

  it('requires a cursor and its capabilities', async () => {
    const handler = new AckPrincipalReportsHandler();
    expect((await handler.execute(makeCtx({}))).success).toBe(false);
    expect((await handler.execute({ ...makeCtx({ cursor: '14' }), entityMemory: undefined } as ToolContext)).success).toBe(false);
    expect((await handler.execute({ ...makeCtx({ cursor: '14' }), auditLogRepo: undefined } as ToolContext)).success).toBe(false);
  });
});
