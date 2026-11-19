// The shared web thread is one Postgres row. These cases use the real server
// so a typo in the adoption query or the insert race cannot hide behind a stub.
// Skips when DATABASE_URL is unset. CI migrates before the suite.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { clearWebThreadCache, getOrCreateWebThread, readWebThreadAndSetupPhase, rotateWebThread, type WebThreadQueryable } from '../../src/channels/http/web-thread.js';
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
    'wt-rotated',
    'wt-rotated-fresh',
    'wt-before-race',
    'wt-after-race',
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

  // #2358: Start onboarding gives the principal a new thread; the Setup chat stays in
  // working_memory, and every reader of the pointer sees the new id at once.
  it('rotation moves the pointer and the cache, and keeps the old conversation', async () => {
    clearWebThreadCache(pool);
    const before = await getOrCreateWebThread(pool);
    await expect(rotateWebThread(pool, { newId: () => 'wt-rotated' })).resolves.toBe('wt-rotated');
    await expect(getOrCreateWebThread(pool)).resolves.toBe('wt-rotated');
    clearWebThreadCache(pool);
    await expect(getOrCreateWebThread(pool)).resolves.toBe('wt-rotated');
    if (before !== 'wt-rotated') {
      const kept = await pool.query('SELECT 1 FROM working_memory WHERE conversation_id = $1 LIMIT 1', [before]);
      // A minted id has no turns; an adopted one keeps them.
      if (['wt-web-new', 'wt-web-old'].includes(before)) expect(kept.rows).toHaveLength(1);
    }
  });

  it('rotation creates the row when there is none yet', async () => {
    await pool.query('DELETE FROM web_thread WHERE id = 1');
    clearWebThreadCache(pool);
    await expect(rotateWebThread(pool, { newId: () => 'wt-rotated-fresh' })).resolves.toBe('wt-rotated-fresh');
    const stored = await pool.query<{ conversation_id: string }>('SELECT conversation_id FROM web_thread WHERE id = 1');
    expect(stored.rows[0]?.conversation_id).toBe('wt-rotated-fresh');
  });

  // A cold-cache read that saw the old row must not overwrite a rotation that finished
  // while it ran (#2358, CodeRabbit on #2687).
  it('a read in flight during a rotation returns, and keeps, the new id', async () => {
    await rotateWebThread(pool, { newId: () => 'wt-before-race' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    // One wrapper for both callers: the cache is keyed by the pool object.
    const slow: WebThreadQueryable = {
      query: async (sql, params) => {
        const result = await pool.query(sql, params as unknown[]);
        if (!held && sql.includes('SELECT conversation_id FROM web_thread')) {
          held = true;
          await gate;
        }
        return result;
      },
    };
    clearWebThreadCache(slow);
    const inFlight = getOrCreateWebThread(slow);
    await vi.waitFor(() => expect(held).toBe(true));
    await rotateWebThread(slow, { newId: () => 'wt-after-race' });
    release();
    await expect(inFlight).resolves.toBe('wt-after-race');
    await expect(getOrCreateWebThread(slow)).resolves.toBe('wt-after-race');
  });

  it('reads the thread and the Setup phase together', async () => {
    const saved = (await pool.query('SELECT * FROM setup_state WHERE id = 1')).rows[0] as Record<string, unknown> | undefined;
    try {
      await pool.query('DELETE FROM setup_state WHERE id = 1');
      await rotateWebThread(pool, { newId: () => 'wt-after-race' });
      await expect(readWebThreadAndSetupPhase(pool)).resolves.toEqual({ conversationId: 'wt-after-race', setupPhase: null });
      await pool.query(`INSERT INTO setup_state (id, phase) VALUES (1, 'in_progress')`);
      await expect(readWebThreadAndSetupPhase(pool)).resolves.toEqual({ conversationId: 'wt-after-race', setupPhase: 'in_progress' });
    } finally {
      await pool.query('DELETE FROM setup_state WHERE id = 1');
      if (saved) {
        const cols = Object.keys(saved);
        await pool.query(
          `INSERT INTO setup_state (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          cols.map((c) => saved[c]),
        );
      }
    }
  });
});
