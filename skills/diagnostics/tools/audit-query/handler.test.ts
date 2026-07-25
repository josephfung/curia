// skills/audit-query/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { AuditQueryHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { AuditLogRepo, AuditLogRow } from '../../../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../../../src/logger.js';

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    input: {},
    secret: (name: string) => { throw new Error(`secret '${name}' not configured in test`); },
    log: createSilentLogger(),
    timezone: 'America/New_York',
    ...overrides,
  } as ToolContext;
}

function auditRow(overrides?: Partial<AuditLogRow>): AuditLogRow {
  return {
    id: 'evt-1',
    timestamp: new Date('2026-07-07T12:00:00.000Z'),
    eventType: 'tool.result',
    sourceLayer: 'execution',
    sourceId: 'coordinator',
    conversationId: 'conv-1',
    taskId: null,
    parentEventId: 'evt-0',
    payload: { toolName: 'email-send' },
    action: null,
    outcome: null,
    targetType: null,
    targetId: null,
    initiatorType: null,
    initiatorId: null,
    entryHash: null,
    ...overrides,
  };
}

describe('AuditQueryHandler', () => {
  it('errors without auditLogRepo', async () => {
    const result = await new AuditQueryHandler().execute(makeCtx({ auditLogRepo: undefined, input: { event_id: 'x' } }));
    expect(result.success).toBe(false);
  });

  it('requires at least one anchor', async () => {
    const repo = {} as unknown as AuditLogRepo;
    const result = await new AuditQueryHandler().execute(makeCtx({ auditLogRepo: repo, input: {} }));
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/anchor/);
  });

  it('routes an event_id to findById and returns one redacted record', async () => {
    const findById = vi.fn().mockResolvedValue(auditRow());
    const repo = { findById } as unknown as AuditLogRepo;
    const result = await new AuditQueryHandler().execute(makeCtx({ auditLogRepo: repo, input: { event_id: 'evt-1' } }));

    expect(findById).toHaveBeenCalledWith('evt-1');
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { events: Array<Record<string, unknown>>; count: number; available: boolean } }).data;
    expect(data.count).toBe(1);
    expect(data.available).toBe(true);
    expect(data.events[0]).toMatchObject({ id: 'evt-1', eventType: 'tool.result', parentEventId: 'evt-0' });
    expect(data.events[0]!.payloadSummary).toEqual({ toolName: 'email-send' });
  });

  it('reports available:false when findById misses', async () => {
    const repo = { findById: vi.fn().mockResolvedValue(null) } as unknown as AuditLogRepo;
    const result = await new AuditQueryHandler().execute(makeCtx({ auditLogRepo: repo, input: { event_id: 'nope' } }));
    expect(result.success).toBe(true);
    expect((result as { success: true; data: { available: boolean } }).data.available).toBe(false);
  });

  it('routes a block_id to findByBlockId with the window', async () => {
    const findByBlockId = vi.fn().mockResolvedValue([auditRow({ eventType: 'outbound.blocked' })]);
    const repo = { findByBlockId } as unknown as AuditLogRepo;
    const result = await new AuditQueryHandler().execute(makeCtx({
      auditLogRepo: repo,
      input: { block_id: 'block_32381e36', since: '2026-07-07T00:00:00.000Z' },
    }));
    expect(result.success).toBe(true);
    expect(findByBlockId).toHaveBeenCalledWith('block_32381e36', expect.objectContaining({ from: new Date('2026-07-07T00:00:00.000Z') }));
  });

  it('scrubs PII from the payload summary', async () => {
    const findById = vi.fn().mockResolvedValue(auditRow({ payload: { note: 'contact alice@example.com about it' } }));
    const repo = { findById } as unknown as AuditLogRepo;
    const result = await new AuditQueryHandler().execute(makeCtx({ auditLogRepo: repo, input: { event_id: 'evt-1' } }));
    const summary = (result as { success: true; data: { events: Array<{ payloadSummary: { note: string } }> } }).data.events[0]!.payloadSummary;
    expect((summary as { note: string }).note).not.toContain('alice@example.com');
  });

  it('rejects a malformed since timestamp', async () => {
    const repo = { findTimeline: vi.fn() } as unknown as AuditLogRepo;
    const result = await new AuditQueryHandler().execute(makeCtx({ auditLogRepo: repo, input: { conversation_id: 'c', since: 'yesterday' } }));
    expect(result.success).toBe(false);
  });
});
