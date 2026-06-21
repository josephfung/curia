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

  it('postMessage with closeAfter=true persists the reply and closes the thread atomically (#881)', async () => {
    // Full open → reply with close_after → thread is closed flow.
    const { thread } = await service.openThread(`${runId} — Close-after test`, 'coordinator', ['coordinator', 'agent-b'], 'Opening', []);
    const reply = await service.postMessage(thread.id, 'agent-b', 'Concluding reply', [], true);

    const after = await service.getThread(thread.id);
    expect(after).not.toBeNull();
    // The reply was written first and persisted...
    expect(after!.thread.status).toBe('closed');
    expect(after!.thread.messageCount).toBe(2);
    expect(after!.messages.some(m => m.id === reply.id)).toBe(true);
    // ...and the thread is now closed, so further posts are rejected.
    await expect(service.postMessage(thread.id, 'coordinator', 'Too late', [])).rejects.toThrow('closed');
  });

  // Read watermark (#1065): markThreadsSeen stops re-surfacing a handled thread until
  // newer activity arrives. Exercises the bullpen_thread_reads table + the LEFT JOIN.
  it('markThreadsSeen suppresses a pending thread until a newer message arrives', async () => {
    const { thread } = await service.openThread(
      `${runId} — Watermark test`,
      'meeting-debrief',
      ['meeting-debrief', 'coordinator'],
      'Please relay this to the principal',
      ['coordinator'],
    );
    // Pending for the coordinator before it has been seen.
    expect((await service.getPendingThreadsForAgent('coordinator', 60)).map(p => p.threadId)).toContain(thread.id);

    // The coordinator handles it out of band; the runtime stamps the watermark.
    await service.markThreadsSeen('coordinator', [thread.id]);
    // Still open, but no longer pending for the coordinator.
    expect((await service.getThread(thread.id))!.thread.status).toBe('open');
    expect((await service.getPendingThreadsForAgent('coordinator', 60)).map(p => p.threadId)).not.toContain(thread.id);

    // A new message advances last_message_at past the watermark → re-surfaces.
    await service.postMessage(thread.id, 'meeting-debrief', 'one more thing', []);
    expect((await service.getPendingThreadsForAgent('coordinator', 60)).map(p => p.threadId)).toContain(thread.id);
  });

  it('markThreadsSeen is monotonic and per-agent', async () => {
    const { thread } = await service.openThread(
      `${runId} — Watermark monotonic`,
      'creator',
      ['creator', 'coordinator', 'agent-c'],
      'Hi',
      [],
    );
    // Advance the watermark to the current latest message.
    await service.markThreadsSeen('coordinator', [thread.id]);
    // A redundant stamp at the same state is a no-op and must not lower the watermark or throw.
    await service.markThreadsSeen('coordinator', [thread.id]);
    expect((await service.getPendingThreadsForAgent('coordinator', 60)).map(p => p.threadId)).not.toContain(thread.id);
    // A different participant who never saw it still has it pending.
    expect((await service.getPendingThreadsForAgent('agent-c', 60)).map(p => p.threadId)).toContain(thread.id);
  });
});
