// tests/unit/dispatch/dispatcher-context-bridging.test.ts
//
// Tests the v2 context bridging flow: OutboundContextService-backed injection
// into coordinator tasks on inbound messages.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundContextService } from '../../../src/dispatch/outbound-context.js';
import type { OutboundContextRow } from '../../../src/dispatch/outbound-context.js';
import type { DbPool } from '../../../src/db/connection.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makePool() {
  return { query: vi.fn() } as unknown as DbPool;
}

function makeActiveEntry(overrides: Partial<OutboundContextRow> = {}): OutboundContextRow {
  return {
    id: 'entry-1',
    conversationId: 'conv-1',
    channelId: 'signal',
    agentId: 'meeting-debrief',
    contentPreview: 'Any takeaways from the meeting?',
    expectedReply: 'Meeting notes',
    delegationHint: 'Delegate to meeting-debrief',
    metadata: { meeting: 'Strategy sync' },
    createdAt: new Date(Date.now() - 5 * 60 * 1000),
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    released: false,
    ...overrides,
  };
}

describe('OutboundContextService integration (read path)', () => {
  let pool: ReturnType<typeof makePool>;
  let service: OutboundContextService;

  beforeEach(() => {
    pool = makePool();
    service = new OutboundContextService(pool, logger);
  });

  it('formatInjectionBlock produces injection when active entries exist', () => {
    const entries = [makeActiveEntry()];
    const result = service.formatInjectionBlock(entries, 'Hello from CEO');

    expect(result).not.toBeNull();
    expect(result).toContain('[ACTIVE OUTBOUND CONTEXT');
    expect(result).toContain('entry_id: entry-1');
    expect(result).toContain('on behalf of meeting-debrief');
    expect(result).toContain('Hello from CEO');
  });

  it('formatInjectionBlock returns null when no entries', () => {
    const result = service.formatInjectionBlock([], 'Hello');
    expect(result).toBeNull();
  });

  it('getActive queries only non-released, non-expired entries', async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await service.getActive();

    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain('released = false');
    expect(sql).toContain('expires_at > now()');
  });
});
