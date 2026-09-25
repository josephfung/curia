import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { BULLPEN_PENDING_WINDOW_MINUTES, BullpenService } from '../../src/memory/bullpen.js';
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

  async function backdateThread(threadId: string, age: string): Promise<void> {
    await pool.query(
      `UPDATE bullpen_threads SET last_message_at = NOW() - $2::interval WHERE id = $1`,
      [threadId, age],
    );
  }

  // The recency predicate runs in Postgres. A mock cannot tell minutes from
  // milliseconds: excluding a two-hour-old row also passes when `60` is read as
  // 60ms. The 30-minute row is what fails that regression. (#1899)
  it('getPendingThreadsForAgent applies the window in minutes against real rows (#1899)', async () => {
    const agentId = `agent-${runId}-minutes`;
    const creator = `creator-${runId}-minutes`;
    const { thread: inside } = await service.openThread(
      `${runId} — 30 min`,
      creator,
      [creator, agentId],
      'recent',
      [agentId],
    );
    const { thread: outside } = await service.openThread(
      `${runId} — 90 min`,
      creator,
      [creator, agentId],
      'stale',
      [agentId],
    );
    await backdateThread(inside.id, '30 minutes');
    await backdateThread(outside.id, '90 minutes');

    const ids = (await service.getPendingThreadsForAgent(agentId, 60)).map(p => p.threadId);
    expect(ids).toContain(inside.id);
    expect(ids).not.toContain(outside.id);
  });

  it('default window recovers an hours-old handoff and keeps the seen and self-sender guards (#1899)', async () => {
    const agentId = `agent-${runId}-default`;
    const creator = `creator-${runId}-default`;

    const { thread: halfHour } = await service.openThread(
      `${runId} — 30 min default`,
      creator,
      [creator, agentId],
      'please handle this',
      [agentId],
    );
    const { thread: elevenHours } = await service.openThread(
      `${runId} — 11 hours`,
      creator,
      [creator, agentId],
      'please handle this',
      [agentId],
    );
    const { thread: eightDays } = await service.openThread(
      `${runId} — 8 days`,
      creator,
      [creator, agentId],
      'please handle this',
      [agentId],
    );
    const { thread: seen } = await service.openThread(
      `${runId} — seen`,
      creator,
      [creator, agentId],
      'please handle this',
      [agentId],
    );
    const { thread: selfLast } = await service.openThread(
      `${runId} — self last`,
      creator,
      [creator, agentId],
      'please handle this',
      [agentId],
    );
    await service.postMessage(selfLast.id, agentId, 'done', []);

    await backdateThread(halfHour.id, '30 minutes');
    await backdateThread(elevenHours.id, '11 hours');
    await backdateThread(eightDays.id, '8 days');
    await backdateThread(seen.id, '11 hours');
    await service.markThreadsSeen(agentId, [seen.id]);
    await backdateThread(selfLast.id, '11 hours');

    const ids = (await service.getPendingThreadsForAgent(agentId, BULLPEN_PENDING_WINDOW_MINUTES)).map(p => p.threadId);
    expect(ids).toContain(halfHour.id);
    expect(ids).toContain(elevenHours.id);
    expect(ids).not.toContain(eightDays.id);
    expect(ids).not.toContain(seen.id);
    expect(ids).not.toContain(selfLast.id);
  });

  it('reserves one of the five slots for the oldest eligible thread (#1899)', async () => {
    const agentId = `agent-${runId}-cap`;
    const creator = `creator-${runId}-cap`;
    const idsByAge = new Map<number, string>();
    for (let ageDays = 1; ageDays <= 6; ageDays++) {
      const { thread } = await service.openThread(
        `${runId} — age ${ageDays}d`,
        creator,
        [creator, agentId],
        `message ${ageDays}`,
        [agentId],
      );
      await backdateThread(thread.id, `${ageDays} days`);
      idsByAge.set(ageDays, thread.id);
    }

    const ids = (await service.getPendingThreadsForAgent(agentId, BULLPEN_PENDING_WINDOW_MINUTES)).map(p => p.threadId);
    expect(ids).toContain(idsByAge.get(6));
    expect(ids).toContain(idsByAge.get(1));
    expect(ids).toContain(idsByAge.get(2));
    expect(ids).toContain(idsByAge.get(3));
    expect(ids).toContain(idsByAge.get(4));
    expect(ids).not.toContain(idsByAge.get(5));
    expect(ids).toHaveLength(5);
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
