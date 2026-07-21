// skills/audit-trace/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { AuditTraceHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { AuditLogRepo, AuditLogRow } from '../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    input: {},
    secret: (name: string) => { throw new Error(`secret '${name}' not configured in test`); },
    log: createSilentLogger(),
    timezone: 'America/New_York',
    ...overrides,
  } as ToolContext;
}

function row(id: string, parentEventId: string | null, tsIso: string, overrides?: Partial<AuditLogRow>): AuditLogRow {
  return {
    id,
    timestamp: new Date(tsIso),
    eventType: 'agent.task',
    sourceLayer: 'agent',
    sourceId: 'coordinator',
    conversationId: 'conv-1',
    parentEventId,
    payload: {},
    ...overrides,
  };
}

/** Build a repo over a seeded set of rows: findById by id, findChildren by parent_event_id. */
function seededRepo(rows: AuditLogRow[]): AuditLogRepo {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    findById: vi.fn(async (id: string) => byId.get(id) ?? null),
    findChildren: vi.fn(async (parentEventId: string, opts?: { limit?: number }) => {
      const kids = rows.filter((r) => r.parentEventId === parentEventId);
      return typeof opts?.limit === 'number' ? kids.slice(0, opts.limit) : kids;
    }),
    findByBlockId: vi.fn(async () => []),
  } as unknown as AuditLogRepo;
}

describe('AuditTraceHandler', () => {
  it('returns error when auditLogRepo is unavailable', async () => {
    const result = await new AuditTraceHandler().execute(makeCtx({ auditLogRepo: undefined, input: { event_id: 'e1' } }));
    expect(result.success).toBe(false);
  });

  it('requires an event_id or block_id', async () => {
    const result = await new AuditTraceHandler().execute(makeCtx({ auditLogRepo: seededRepo([]), input: {} }));
    expect(result.success).toBe(false);
  });

  it('reconstructs the causal chain: parents up + children down, in timestamp order', async () => {
    // e0 (root) → e1 (anchor) → e2 (child) → e3 (grandchild); e1 also has sibling-child e2b.
    const rows = [
      row('e0', null, '2026-07-07T08:00:00.000Z'),
      row('e1', 'e0', '2026-07-07T08:00:01.000Z'),
      row('e2', 'e1', '2026-07-07T08:00:02.000Z'),
      row('e2b', 'e1', '2026-07-07T08:00:03.000Z'),
      row('e3', 'e2', '2026-07-07T08:00:04.000Z'),
    ];
    const repo = seededRepo(rows);
    const result = await new AuditTraceHandler().execute(makeCtx({ auditLogRepo: repo, input: { event_id: 'e1' } }));

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { anchor_event_id: string; chain: Array<{ id: string }>; count: number; truncated: boolean; available: boolean } }).data;
    expect(data.anchor_event_id).toBe('e1');
    expect(data.available).toBe(true);
    expect(data.truncated).toBe(false);
    // Ancestor (e0) + anchor (e1) + descendants (e2, e2b, e3), ordered by timestamp.
    expect(data.chain.map((e) => e.id)).toEqual(['e0', 'e1', 'e2', 'e2b', 'e3']);
    expect(data.count).toBe(5);
  });

  it('reports available:false when the anchor event does not exist', async () => {
    const result = await new AuditTraceHandler().execute(makeCtx({ auditLogRepo: seededRepo([]), input: { event_id: 'missing' } }));
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { available: boolean; count: number } }).data;
    expect(data.available).toBe(false);
    expect(data.count).toBe(0);
  });

  it('flags truncated when the upward walk hits max_depth before the root', async () => {
    const rows = [
      row('e0', null, '2026-07-07T08:00:00.000Z'),
      row('e1', 'e0', '2026-07-07T08:00:01.000Z'),
      row('e2', 'e1', '2026-07-07T08:00:02.000Z'),
    ];
    const result = await new AuditTraceHandler().execute(
      makeCtx({ auditLogRepo: seededRepo(rows), input: { event_id: 'e2', max_depth: 1 } }),
    );
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { truncated: boolean; chain_broken: boolean; chain: Array<{ id: string }> } }).data;
    // max_depth 1: from e2 we reach e1 but not e0.
    expect(data.chain.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(data.truncated).toBe(true);
    expect(data.chain_broken).toBe(false); // a bound stopped us, the chain is intact
  });

  it('reports chain_broken (not truncated) when a parent_event_id points to a missing row', async () => {
    // e1 references parent e0, which is NOT in the log — a dangling parent_event_id.
    const rows = [
      row('e1', 'e0', '2026-07-07T08:00:01.000Z'),
      row('e2', 'e1', '2026-07-07T08:00:02.000Z'),
    ];
    const result = await new AuditTraceHandler().execute(makeCtx({ auditLogRepo: seededRepo(rows), input: { event_id: 'e1' } }));

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { truncated: boolean; chain_broken: boolean; chain: Array<{ id: string }> } }).data;
    expect(data.chain_broken).toBe(true);
    // Crucially NOT truncated — narrowing the scope can never recover a missing row.
    expect(data.truncated).toBe(false);
    expect(data.chain.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('resolves a block_id anchor by preferring the outbound.blocked event', async () => {
    const blocked = row('b-evt', 'e0', '2026-07-07T08:00:05.000Z', { eventType: 'outbound.blocked' });
    const other = row('n-evt', 'e0', '2026-07-07T08:00:06.000Z', { eventType: 'outbound.notification' });
    const repo = {
      findById: vi.fn(async (id: string) => (id === 'e0' ? row('e0', null, '2026-07-07T08:00:00.000Z') : null)),
      findChildren: vi.fn(async () => []),
      findByBlockId: vi.fn(async () => [other, blocked]),
    } as unknown as AuditLogRepo;

    const result = await new AuditTraceHandler().execute(makeCtx({ auditLogRepo: repo, input: { block_id: 'block_abc' } }));
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { anchor_event_id: string } }).data;
    expect(data.anchor_event_id).toBe('b-evt');
  });
});
