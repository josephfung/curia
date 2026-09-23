// The contact-recent SQL is the production leak guard. The in-memory selector
// is a twin, not a substitute — this runs WorkingMemory.getContactRecentHistory
// against Postgres. Skips when DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { backfillDirectChannelSenders } from '../../src/memory/direct-sender-backfill.js';
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

const DIRECT_IDS = [
  'signal:crh-1599-peer',
  'signal:group=crh-1599',
  'sms:crh-1599-peer',
  'email:crh-1599-old',
];

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(
    `DELETE FROM working_memory WHERE conversation_id LIKE $1 OR conversation_id = ANY($2::text[])`,
    [`${PREFIX}%`, DIRECT_IDS],
  );
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

  it('stamps historical Signal 1:1 and SMS rows so an old null sender stops hiding replies', async () => {
    const alice = await seedContact(pool, 'direct-alice');
    await pool.query(
      `INSERT INTO contact_channel_identities (contact_id, channel, channel_identifier, source)
       VALUES ($1, 'signal', 'crh-1599-peer', 'manual'),
              ($1, 'sms', 'crh-1599-peer', 'manual')`,
      [alice],
    );
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const now = new Date();
    // Distinct timestamps: equal created_at ties on a random id, so order is not stable.
    const replyAt = new Date(now.getTime() + 1000);
    await pool.query(
      `INSERT INTO working_memory (conversation_id, agent_id, role, content, created_at, archived, sender_contact_id, channel_id)
       VALUES
         ('signal:crh-1599-peer', 'coordinator', 'user', 'old signal line', $2, true, NULL, NULL),
         ('signal:crh-1599-peer', 'coordinator', 'user', 'today on signal', $3, false, $1, 'signal'),
         ('signal:crh-1599-peer', 'coordinator', 'assistant', 'signal reply kept', $4, false, NULL, 'signal'),
         ('signal:group=crh-1599', 'coordinator', 'user', 'group line', $2, true, NULL, NULL),
         ('sms:crh-1599-peer', 'coordinator', 'user', 'old sms line', $2, true, NULL, NULL),
         ('email:crh-1599-old', 'coordinator', 'user', 'old email line', $2, true, NULL, NULL)`,
      [alice, old, now, replyAt],
    );

    const before = await memory.getContactRecentHistory({
      contactId: alice,
      agentId: 'coordinator',
      excludeConversationId: 'email:somewhere-else',
      since: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(before.map(t => t.content)).toEqual(['today on signal']);

    const stamped = await backfillDirectChannelSenders(pool, createLogger('error'), { batchSize: 1 });
    expect(stamped.signalRows).toBe(1);
    expect(stamped.smsRows).toBe(1);

    const after = await memory.getContactRecentHistory({
      contactId: alice,
      agentId: 'coordinator',
      excludeConversationId: 'email:somewhere-else',
      since: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(after.map(t => t.content)).toEqual(['today on signal', 'signal reply kept']);

    const leftovers = await pool.query<{ conversation_id: string; sender_contact_id: string | null }>(
      `SELECT conversation_id, sender_contact_id
       FROM working_memory
       WHERE conversation_id = ANY($1::text[]) AND role = 'user' AND content IN ('group line', 'old email line')
       ORDER BY conversation_id`,
      [['signal:group=crh-1599', 'email:crh-1599-old']],
    );
    expect(leftovers.rows.map(row => row.sender_contact_id)).toEqual([null, null]);
  });
});
