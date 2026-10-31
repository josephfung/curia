// A subscription disappears with its session, and an expired session's subscription
// is neither reachable nor sent to before the prune deletes it (#2341). Skips without
// DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { WebPushService, hasLivePairedSubscription, type PushSender } from '../../src/channels/web/push-service.js';
import { createLogger } from '../../src/logger.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('web push subscriptions (integration)', () => {
  let pool: pg.Pool;
  const sessionId = randomUUID();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `INSERT INTO sessions (id, token_hash, expires_at) VALUES ($1, $2, NOW() + interval '1 hour')`,
      [sessionId, `test-${sessionId}`],
    );
  });

  afterAll(async () => {
    try {
      await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    } finally {
      await pool.end();
    }
  });

  it('counts any live session when push is configured', async () => {
    await pool.query(
      `INSERT INTO push_subscriptions (session_id, endpoint, p256dh, auth_secret)
       VALUES ($1, $2, 'p256', 'auth')`,
      [sessionId, `https://updates.push.services.mozilla.com/wpush/v2/${sessionId}`],
    );
    expect(await hasLivePairedSubscription(pool, false)).toBe(false);
    expect(await hasLivePairedSubscription(pool)).toBe(true);
  });

  it('deletes the subscription when the session is deleted', async () => {
    await pool.query(
      `INSERT INTO push_subscriptions (session_id, endpoint, p256dh, auth_secret)
       VALUES ($1, $2, 'p256', 'auth')`,
      [sessionId, `https://fcm.googleapis.com/fcm/send/${sessionId}`],
    );
    const before = await pool.query(`SELECT id FROM push_subscriptions WHERE session_id = $1`, [sessionId]);
    expect(before.rows).toHaveLength(1);
    await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    const after = await pool.query(`SELECT id FROM push_subscriptions WHERE session_id = $1`, [sessionId]);
    expect(after.rows).toHaveLength(0);
  });

  it('neither counts nor sends to the subscription of an expired session', async () => {
    // One transaction, rolled back: the service reads the whole table, so rows other
    // tests left behind are hidden from it rather than deleted.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM push_subscriptions');
      const expired = randomUUID();
      const live = randomUUID();
      await client.query(
        `INSERT INTO sessions (id, token_hash, expires_at, name) VALUES
           ($1, $2, NOW() - interval '1 minute', 'Old phone'),
           ($3, $4, NOW() + interval '1 hour', 'iPhone')`,
        [expired, `test-${expired}`, live, `test-${live}`],
      );
      await client.query(
        `INSERT INTO push_subscriptions (session_id, endpoint, p256dh, auth_secret)
         VALUES ($1, $2, 'p256', 'auth')`,
        [expired, `https://fcm.googleapis.com/fcm/send/${expired}`],
      );
      const sent: Array<{ endpoint: string; deviceName: string | null }> = [];
      const sender: PushSender = {
        send: async (sub) => {
          sent.push({ endpoint: sub.endpoint, deviceName: sub.deviceName });
        },
      };
      const push = new WebPushService({
        pool: client,
        sender,
        logger: createLogger('silent'),
        configured: true,
        memory: { addTurn: async () => undefined },
      });

      await expect(push.reachableNow()).resolves.toBe(false);
      await expect(push.deliver('hello')).resolves.toEqual({
        outcome: 'unavailable',
        detail: 'No phone is subscribed to notifications.',
      });
      expect(sent).toEqual([]);

      await client.query(
        `INSERT INTO push_subscriptions (session_id, endpoint, p256dh, auth_secret)
         VALUES ($1, $2, 'p256', 'auth')`,
        [live, `https://fcm.googleapis.com/fcm/send/${live}`],
      );
      await expect(push.reachableNow()).resolves.toBe(true);
      await expect(push.deliver('hello')).resolves.toEqual({ outcome: 'delivered' });
      expect(sent).toEqual([{ endpoint: `https://fcm.googleapis.com/fcm/send/${live}`, deviceName: 'iPhone' }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
