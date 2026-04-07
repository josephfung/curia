import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { BullpenService } from '../../src/memory/bullpen.js';
import { createLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('BullpenService integration (Postgres)', () => {
  let pool: pg.Pool;
  let service: BullpenService;
  // Per-run ID ensures concurrent test runs don't clobber each other's rows
  let runId: string;

  beforeAll(async () => {
    runId = randomUUID();
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM bullpen_threads LIMIT 0');
    const logger = createLogger('error');
    service = BullpenService.createWithPostgres(pool, logger);
  });

  afterAll(async () => {
    // Delete only rows created by this run, scoped by the runId topic prefix.
    // ON DELETE CASCADE handles bullpen_messages automatically.
    await pool.query(
      `DELETE FROM bullpen_threads WHERE topic LIKE $1`,
      [`${runId}%`],
    );
    await pool.end();
  });

  it('opens a thread and persists to Postgres', async () => {
    const { thread, message } = await service.openThread(
      `${runId} — Integration test thread`,
      'coordinator',
      ['coordinator', 'agent-b'],
      'Hello agent-b',
      ['agent-b'],
    );
    const fetched = await service.getThread(thread.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.thread.topic).toBe(`${runId} — Integration test thread`);
    expect(fetched!.messages).toHaveLength(1);
    expect(fetched!.messages[0]!.id).toBe(message.id);
  });

  it('postMessage increments message_count and updates last_message_at', async () => {
    const { thread } = await service.openThread(`${runId} — Count test`, 'coordinator', ['coordinator', 'agent-b'], 'Msg 1', []);
    const before = await service.getThread(thread.id);
    await service.postMessage(thread.id, 'agent-b', 'Msg 2', []);
    const after = await service.getThread(thread.id);
    expect(after!.thread.messageCount).toBe(before!.thread.messageCount + 1);
    expect(after!.thread.lastMessageAt!.getTime()).toBeGreaterThanOrEqual(before!.thread.lastMessageAt!.getTime());
  });

  it('getPendingThreadsForAgent respects time window', async () => {
    const { thread } = await service.openThread(`${runId} — Old thread`, 'coordinator', ['coordinator', 'agent-b'], 'Old', []);
    // Force last_message_at to be 2 hours ago
    await pool.query(
      `UPDATE bullpen_threads SET last_message_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
      [thread.id],
    );
    // 60-minute window should exclude this thread
    const pending = await service.getPendingThreadsForAgent('agent-b', 60);
    expect(pending.find(p => p.threadId === thread.id)).toBeUndefined();
  });

  it('closeThread prevents further posts', async () => {
    const { thread } = await service.openThread(`${runId} — Close test`, 'coordinator', ['coordinator'], 'Hi', []);
    await service.closeThread(thread.id, 'coordinator');
    // Verify the DB write actually persisted the closed status
    const closed = await service.getThread(thread.id);
    expect(closed!.thread.status).toBe('closed');
    // Also verify the application-layer guard blocks further posts
    await expect(service.postMessage(thread.id, 'coordinator', 'After close', [])).rejects.toThrow('closed');
  });
});
