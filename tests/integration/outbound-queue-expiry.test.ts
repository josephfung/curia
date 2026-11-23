// A queued system notice that expires unsent is reported, so the gateway can audit it (#2710).
//
// The queue's expiry is two DELETEs (the enqueue's own prune, and listPending's), each with a
// RETURNING clause that reads the notice type out of the JSONB payload. This runs them against a
// real Postgres. A freshly migrated scratch database keeps the prunes from touching any other
// file's rows: both DELETEs remove every expired row on the channel.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { createScratchDatabase, type ScratchDatabase } from './scratch-database.js';
import { OutboundQueueRepo } from '../../src/skills/outbound-queue-repo.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('outbound queue expiry of system notices (Postgres)', () => {
  let scratch: ScratchDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    scratch = await createScratchDatabase(DATABASE_URL!, 'outbound_queue_expiry');
    pool = new pg.Pool({ connectionString: scratch.url });
  });

  afterAll(async () => {
    await pool.end();
    await scratch.drop();
  });

  const notice = { channel: 'email' as const, to: 'operator@example.com', subject: 'Suspended', body: 'Body' };

  async function expire(id: string): Promise<void> {
    await pool.query(`UPDATE outbound_queue SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
  }

  it('reports an expired system notice from listPending, and not plain correspondence', async () => {
    const handler = vi.fn();
    const repo = new OutboundQueueRepo(pool);
    repo.setExpiredNotificationHandler(handler);

    const { id: noticeId } = await repo.enqueue(notice, { systemNotification: true, notificationType: 'schedule_suspended' });
    const { id: mailId } = await repo.enqueue({ ...notice, to: 'someone@example.com' });
    await expire(noticeId);
    await expire(mailId);

    expect(await repo.listPending('email')).toEqual([]);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(['schedule_suspended']);
  });

  it('reports one the enqueue prune removes, and lists a live notice without its markers', async () => {
    const handler = vi.fn();
    const repo = new OutboundQueueRepo(pool);
    repo.setExpiredNotificationHandler(handler);

    const { id: oldId } = await repo.enqueue(notice, { systemNotification: true, notificationType: 'database_unavailable' });
    await expire(oldId);
    const { id: liveId } = await repo.enqueue(notice, { systemNotification: true, notificationType: 'operator_configured' });

    expect(handler).toHaveBeenCalledWith(['database_unavailable']);
    const pending = await repo.listPending('email');
    expect(pending.map((row) => row.id)).toEqual([liveId]);
    expect(pending[0]!.systemNotification).toBe(true);
    expect(pending[0]!.payload).toEqual(notice);

    await pool.query('DELETE FROM outbound_queue WHERE id = $1', [liveId]);
  });
});
