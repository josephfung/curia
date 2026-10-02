// tests/integration/outbound-context-keep-open.test.ts
//
// #1972: the delegate releases the outbound-context entry whose reply it routed,
// unless the specialist kept the exchange open for that delegation. The keep-open
// mark lives in the entry's JSONB metadata and the release is one conditional
// UPDATE, so the SQL is only meaningfully tested against real Postgres.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('outbound-context keep-open and conditional release (#1972)', () => {
  let pool: pg.Pool;
  let service: OutboundContextService;
  const conversationId = `test-keep-open-${randomUUID()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM outbound_context LIMIT 0');
    service = new OutboundContextService(pool, createSilentLogger());
  });

  afterAll(async () => {
    // Only this suite's rows: the shared test DB carries other suites' entries.
    await pool.query('DELETE FROM outbound_context WHERE conversation_id = $1', [conversationId]);
    await pool.end();
  });

  async function register(metadata?: Record<string, unknown>): Promise<string> {
    return service.register({
      conversationId,
      channelId: 'signal',
      agentId: 'ceo-inbox',
      content: 'Dana proposed Tuesday 8am. Accept, or suggest another time?',
      delegationHint: 'ceo-inbox',
      ...(metadata ? { metadata } : {}),
      expiresInHours: 1,
    });
  }

  async function released(id: string): Promise<boolean> {
    const { rows } = await pool.query<{ released: boolean }>('SELECT released FROM outbound_context WHERE id = $1', [id]);
    return rows[0]!.released;
  }

  it('releases an entry nobody kept open, including one with no metadata', async () => {
    const id = await register();
    expect(await service.releaseUnlessKeptOpen(id, 'task-a')).toBe('released');
    expect(await released(id)).toBe(true);
  });

  it('keeps an entry the same delegation marked open, preserving its other metadata', async () => {
    const id = await register({ subject: 'Partnership call' });
    expect(await service.markExchangeOpen(id, { agentId: 'ceo-inbox', taskEventId: 'task-b', reason: 'needs a day' })).toBe(true);

    expect(await service.releaseUnlessKeptOpen(id, 'task-b')).toBe('kept_open');
    expect(await released(id)).toBe(false);

    const entry = await service.getEntry(id);
    expect(entry?.metadata).toMatchObject({
      subject: 'Partnership call',
      exchange_open: { agent_id: 'ceo-inbox', task_event_id: 'task-b', reason: 'needs a day' },
    });
  });

  it('does not let an earlier delegation\'s mark hold a later delegation\'s release', async () => {
    const id = await register();
    await service.markExchangeOpen(id, { agentId: 'ceo-inbox', taskEventId: 'task-c1' });
    expect(await service.releaseUnlessKeptOpen(id, 'task-c2')).toBe('released');
  });

  it('reports not_active for an entry already released, and refuses to mark it', async () => {
    const id = await register();
    await service.releaseEntry(id);
    expect(await service.releaseUnlessKeptOpen(id, 'task-d')).toBe('not_active');
    expect(await service.markExchangeOpen(id, { agentId: 'ceo-inbox', taskEventId: 'task-d' })).toBe(false);
  });
});
