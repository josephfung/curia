// A subscription disappears with its session (#2341). Skips without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

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
});
