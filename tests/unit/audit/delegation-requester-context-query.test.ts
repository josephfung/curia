import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AuditLogRepo } from '../../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../../src/logger.js';

describe('AuditLogRepo.findDelegationRequesterContext', () => {
  it('queries one delegation by event id and maps the evidence row', async () => {
    const evidence = {
      delegateEventId: 'task-1',
      taskId: 'task-1',
      agentId: 'calendar',
      conversationId: 'conv-1',
      contactId: 'ceo-contact-id',
      channel: 'signal',
      systemRole: 'principal',
      tier: 'principal',
      tierPresent: true,
      delegatedAddendumApplied: true,
    };
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: 'audit-1',
        timestamp: '2026-09-26T03:00:00.000Z',
        event_type: 'delegation.requester_context',
        source_layer: 'agent',
        source_id: 'calendar',
        conversation_id: 'conv-1',
        task_id: 'task-1',
        parent_event_id: 'task-1',
        payload: evidence,
        action: 'record',
        outcome: 'success',
        target_type: 'delegation',
        target_id: 'task-1',
        initiator_type: 'agent',
        initiator_id: 'calendar',
        entry_hash: 'abc',
      }],
    });
    const repo = new AuditLogRepo({ query } as unknown as Pool, createSilentLogger());

    const rows = await repo.findDelegationRequesterContext('task-1');

    expect(query).toHaveBeenCalledOnce();
    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toContain("event_type = 'delegation.requester_context'");
    expect(sql).toContain("target_type = 'delegation' AND target_id = $1");
    expect(sql).toContain("payload->>'delegateEventId' = $1");
    expect(query.mock.calls[0]![1]).toEqual(['task-1', 100]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'delegation.requester_context',
      taskId: 'task-1',
      parentEventId: 'task-1',
      targetType: 'delegation',
      targetId: 'task-1',
      payload: evidence,
    });
  });

  it('does not query when the delegation id is empty', async () => {
    const query = vi.fn();
    const repo = new AuditLogRepo({ query } as unknown as Pool, createSilentLogger());
    await expect(repo.findDelegationRequesterContext('')).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
