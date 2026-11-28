import { describe, it, expect, vi } from 'vitest';
import { ListPrincipalReportsHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { AuditLogRepo, AuditLogRow } from '../../../../src/audit/audit-log-repo.js';
import type { EntityMemory } from '../../../../src/memory/entity-memory.js';
import { createSilentLogger } from '../../../../src/logger.js';

function row(id: string, at: string, summary: string): AuditLogRow {
  return {
    id, timestamp: new Date(at), eventType: 'principal.report', sourceLayer: 'dispatch', sourceId: 'dispatch',
    conversationId: null, taskId: null, parentEventId: 't', payload: { summary, urgency: 'digest', source: 'agent' },
    action: null, outcome: null, targetType: null, targetId: null, initiatorType: null, initiatorId: null, entryHash: null,
  };
}

function makeCtx(rows: AuditLogRow[], hasMore = false) {
  const storeFact = vi.fn();
  const ctx = {
    input: {},
    secret: () => { throw new Error('no secrets'); },
    log: createSilentLogger(),
    timezone: 'America/Toronto',
    auditLogRepo: {
      findByEventTypeAfterSeq: vi.fn().mockResolvedValue({ rows: rows.map((r, i) => ({ seq: String(i + 1), row: r })), hasMore }),
    } as unknown as AuditLogRepo,
    // No marker stored yet: findEntities finds no config anchor.
    entityMemory: { findEntities: vi.fn().mockResolvedValue([]), getFacts: vi.fn(), storeFact } as unknown as EntityMemory,
  } as unknown as ToolContext;
  return { ctx, storeFact };
}

describe('ListPrincipalReportsHandler', () => {
  it('numbers the items, returns the cursor, and never stores a marker', async () => {
    const { ctx, storeFact } = makeCtx([
      row('a', '2026-10-18T13:00:00.000Z', 'Replied to Dana.'),
      row('b', '2026-10-18T14:00:00.000Z', 'Archived a newsletter.'),
    ]);

    const result = await new ListPrincipalReportsHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { data: { items: Array<Record<string, unknown>>; cursor: string; hasMore: boolean; displayTimezone: string } }).data;
    expect(data.items.map((i) => [i.n, i.summary])).toEqual([[1, 'Replied to Dana.'], [2, 'Archived a newsletter.']]);
    // Local time, not raw UTC (CLAUDE.md timestamp rule).
    expect(data.items[0]!.at).toBe('2026-10-18T09:00:00.000-04:00');
    // Audit ids are never shown: numbers only.
    expect(data.items[0]).not.toHaveProperty('id');
    expect(data.cursor).toBe('2');
    expect(data.hasMore).toBe(false);
    expect(data.displayTimezone).toBeTruthy();
    expect(storeFact).not.toHaveBeenCalled();
  });

  it('fails without its capabilities', async () => {
    const { ctx } = makeCtx([]);
    const handler = new ListPrincipalReportsHandler();
    expect((await handler.execute({ ...ctx, auditLogRepo: undefined } as ToolContext)).success).toBe(false);
    expect((await handler.execute({ ...ctx, entityMemory: undefined } as ToolContext)).success).toBe(false);
  });

  it('returns an error, not a throw, when the audit read fails', async () => {
    const { ctx } = makeCtx([]);
    (ctx.auditLogRepo!.findByEventTypeAfterSeq as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));

    const result = await new ListPrincipalReportsHandler().execute(ctx);

    expect(result.success).toBe(false);
  });
});

describe('ListPrincipalReportsHandler — outside contacts (#1320)', () => {
  const OUTSIDER = { originator: { contactId: 'dana-contact', systemRole: null, channel: 'email', initiatedAt: '2026-10-19T12:00:00Z', tier: 'known' } };

  it("refuses a task an outside contact started: the principal's digest is not theirs to read", async () => {
    const { ctx } = makeCtx([row('a', '2026-10-19T09:00:00.000Z', 'Held for your digest: a message from Bob.')]);
    const result = await new ListPrincipalReportsHandler().execute({ ...ctx, taskMetadata: OUTSIDER } as ToolContext);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/principal/);
    expect(ctx.auditLogRepo!.findByEventTypeAfterSeq).not.toHaveBeenCalled();
  });

  it('still serves a scheduled digest (system-originated task)', async () => {
    const { ctx } = makeCtx([]);
    const system = { originator: { ...OUTSIDER.originator, systemRole: 'system', tier: null } };
    const result = await new ListPrincipalReportsHandler().execute({ ...ctx, taskMetadata: system } as ToolContext);
    expect(result.success).toBe(true);
  });
});
