import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { findRunningOriginTurns } from '../../../src/db/queries/pending-delegations.js';

function poolWith(query: ReturnType<typeof vi.fn>): Pool {
  return { query } as unknown as Pool;
}

describe('findRunningOriginTurns (#1917)', () => {
  it('does not query when no origin agents were woken', async () => {
    const query = vi.fn();
    const hits = await findRunningOriginTurns(poolWith(query), {
      targetAgent: 'social-media',
      originAgentIds: [],
    });
    expect(hits).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads only running claims and keeps the newest per origin agent', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{
        origin_agent_id: 'coordinator',
        delegate_event_id: 'delegate-evt-1',
        origin_conversation_id: 'signal:+15551234567',
        origin_channel_id: 'signal',
      }],
    }));
    const hits = await findRunningOriginTurns(poolWith(query), {
      targetAgent: 'social-media',
      originAgentIds: ['coordinator', 'research-analyst'],
    });
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("status = 'running'");
    expect(sql).not.toContain("'pending'");
    expect(sql).toContain('DISTINCT ON (origin_agent_id)');
    expect(query.mock.calls[0]![1]).toEqual(['social-media', ['coordinator', 'research-analyst']]);
    expect(hits).toEqual([{
      originAgentId: 'coordinator',
      delegateEventId: 'delegate-evt-1',
      originConversationId: 'signal:+15551234567',
      originChannelId: 'signal',
    }]);
  });
});
