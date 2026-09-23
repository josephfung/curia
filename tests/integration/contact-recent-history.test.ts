// The contact-recent SQL is the production leak guard. The in-memory selector
// is a twin, not a substitute — this runs WorkingMemory.getContactRecentHistory
// against Postgres. Skips when DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { createLogger } from '../../src/logger.js';
import { VOICE_GREETING_USER_MESSAGE } from '../../src/channels/voice/greeting.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'crh-1599:';

async function seedContact(pool: pg.Pool, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO contacts (display_name) VALUES ($1) RETURNING id`,
    [`${PREFIX}${name}`],
  );
  const row = rows[0];
  if (!row) throw new Error('seedContact: INSERT INTO contacts returned no rows');
  return row.id;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM working_memory WHERE conversation_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM contacts WHERE display_name LIKE $1`, [`${PREFIX}%`]);
}

describeIf('contact recent history SQL (#1599)', () => {
  let pool: pg.Pool;
  let memory: WorkingMemory;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    await pool.query('SELECT sender_contact_id, channel_id FROM working_memory LIMIT 0');
    memory = WorkingMemory.createWithPostgres(pool, createLogger('error'));
  });

  afterAll(async () => {
    try {
      await cleanup(pool);
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    await cleanup(pool);
  });

  it('returns a 1:1 and a sole-sender call, and drops the other people in a shared thread', async () => {
    const alice = await seedContact(pool, 'alice');
    const carol = await seedContact(pool, 'carol');
    const base = Date.now() - 30 * 60 * 1000;
    const at = (offsetMs: number): Date => new Date(base + offsetMs);

    await memory.addTurn(`${PREFIX}email:direct`, 'coordinator', {
      role: 'user',
      content: 'the offer came in at 4.2',
    }, { senderContactId: alice, channelId: 'email', createdAt: at(0) });
    await memory.addTurn(`${PREFIX}email:direct`, 'coordinator', {
      role: 'assistant',
      content: 'I will keep that between us',
    }, { channelId: 'email', createdAt: at(1_000) });

    await memory.addTurn(`${PREFIX}email:cc`, 'coordinator', {
      role: 'user',
      content: 'alice own line',
    }, { senderContactId: alice, channelId: 'email', createdAt: at(2_000) });
    await memory.addTurn(`${PREFIX}email:cc`, 'coordinator', {
      role: 'user',
      content: 'carol secret line',
    }, { senderContactId: carol, channelId: 'email', createdAt: at(3_000) });
    await memory.addTurn(`${PREFIX}email:cc`, 'coordinator', {
      role: 'assistant',
      content: 'noted everyone on the thread',
    }, { channelId: 'email', createdAt: at(4_000) });

    await memory.addTurn(`${PREFIX}voice:earlier`, 'coordinator', {
      role: 'user',
      content: VOICE_GREETING_USER_MESSAGE,
    }, { channelId: 'voice', createdAt: at(5_000) });
    await memory.addTurn(`${PREFIX}voice:earlier`, 'coordinator', {
      role: 'user',
      content: 'can you move the board prep to 4?',
    }, { senderContactId: alice, channelId: 'voice', createdAt: at(6_000) });
    await memory.addTurn(`${PREFIX}voice:earlier`, 'coordinator', {
      role: 'assistant',
      content: 'no, you have the investor call then',
    }, { channelId: 'voice', createdAt: at(7_000) });

    await memory.addTurn(`${PREFIX}email:carol-only`, 'coordinator', {
      role: 'user',
      content: 'carol private plan',
    }, { senderContactId: carol, channelId: 'email', createdAt: at(8_000) });

    const turns = await memory.getContactRecentHistory({
      contactId: alice,
      agentId: 'coordinator',
      excludeConversationId: `${PREFIX}email:new`,
      since: new Date(base - 60_000),
    });

    expect(turns.map(t => t.content)).toEqual([
      'the offer came in at 4.2',
      'I will keep that between us',
      'alice own line',
      'can you move the board prep to 4?',
      'no, you have the investor call then',
    ]);
  });
});
