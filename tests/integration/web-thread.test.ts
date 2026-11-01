// The shared web thread is one Postgres row. These cases use the real server
// so a typo in the adoption query or the insert race cannot hide behind a stub.
// Skips when DATABASE_URL is unset. CI migrates before the suite.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { clearWebThreadCache, getOrCreateWebThread } from '../../src/channels/http/web-thread.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('web thread (integration)', () => {
  let pool: pg.Pool;
  let verified = false;
  const conversations = [
    'wt-web-old',
    'wt-web-new',
    'wt-web-archived',
    'wt-signal-newer',
    'wt-null-channel',
    'wt-race-a',
    'wt-race-b',
  ];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    verified = true;
    await pool.query('DELETE FROM web_thread WHERE id = 1');
    await pool.query('DELETE FROM working_memory WHERE conversation_id = ANY($1::text[])', [conversations]);
    clearWebThreadCache(pool);
    const older = new Date('2026-01-01T00:00:00.000Z');
    const newer = new Date('2026-06-01T00:00:00.000Z');
    const newest = new Date('2026-10-01T00:00:00.000Z');
    await pool.query(
      `INSERT INTO working_memory (conversation_id, agent_id, role, content, created_at, archived, channel_id)
       VALUES
         ('wt-web-old', 'coordinator', 'user', 'old', $1, false, 'web'),
         ('wt-web-new', 'coordinator', 'user', 'new', $2, false, 'web'),
         ('wt-web-archived', 'coordinator', 'user', 'archived', $3, true, 'web'),
         ('wt-signal-newer', 'coordinator', 'user', 'signal', $3, false, 'signal'),
         ('wt-null-channel', 'coordinator', 'user', 'legacy', $3, false, NULL)`,
      [older, newer, newest],
    );
  });

  afterAll(async () => {
    try {
      if (verified) {
        await pool.query('DELETE FROM web_thread WHERE id = 1');
        await pool.query('DELETE FROM working_memory WHERE conversation_id = ANY($1::text[])', [conversations]);
      }
    } finally {
      await pool.end();
    }
  });

  it('adopts the most recent non-archived web conversation', async () => {
    clearWebThreadCache(pool);
    await pool.query('DELETE FROM web_thread WHERE id = 1');
    await expect(getOrCreateWebThread(pool)).resolves.toBe('wt-web-new');
  });

  it('returns the stored row on a later call', async () => {
    clearWebThreadCache(pool);
    const first = await getOrCreateWebThread(pool);
    const second = await getOrCreateWebThread(pool);
    expect(second).toBe(first);
    const stored = await pool.query<{ conversation_id: string }>('SELECT conversation_id FROM web_thread WHERE id = 1');
    expect(stored.rows[0]?.conversation_id).toBe(first);
  });

  it('concurrent first use agrees on one id', async () => {
    await pool.query('DELETE FROM web_thread WHERE id = 1');
    await pool.query(
      `UPDATE working_memory SET archived = true
       WHERE conversation_id = ANY($1::text[])`,
      [['wt-web-old', 'wt-web-new']],
    );
    clearWebThreadCache(pool);
    const [a, b] = await Promise.all([
      getOrCreateWebThread(pool, { newId: () => 'wt-race-a' }),
      getOrCreateWebThread(pool, { newId: () => 'wt-race-b' }),
    ]);
    expect(a).toBe(b);
    expect(['wt-race-a', 'wt-race-b']).toContain(a);
    const stored = await pool.query<{ conversation_id: string }>('SELECT conversation_id FROM web_thread WHERE id = 1');
    expect(stored.rows[0]?.conversation_id).toBe(a);
  });
});
