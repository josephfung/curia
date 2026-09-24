// The contact-recent SQL is the production leak guard. The in-memory selector
// is a twin, not a substitute — this runs WorkingMemory.getContactRecentHistory
// against Postgres. Skips when DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { WorkingMemory, CONTACT_RECENT_HISTORY_SQL } from '../../src/memory/working-memory.js';
import { CHANNEL_RECENT_HISTORY_HOURS } from '../../src/memory/contact-recent-history.js';
import { backfillDirectChannelSenders } from '../../src/memory/direct-sender-backfill.js';
import { createLogger } from '../../src/logger.js';
import { VOICE_GREETING_USER_MESSAGE } from '../../src/channels/voice/greeting.js';
import { requireCuriaTestDatabase } from './require-test-db.js';
import {
  CONTENT_BLOCK_REWRITE_MARKER,
  HISTORICAL_SYNTHETIC_LIKE_PATTERNS,
  LATE_SPECIALIST_RESULT_MARKER,
} from '../../src/memory/synthetic-user-turn.js';

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
    await pool.query('SELECT sender_contact_id, channel_id, synthetic FROM working_memory LIMIT 0');
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
      // Curia's own opening row, exactly as VoiceRuntime writes it (#1892).
    }, { channelId: 'voice', synthetic: true, createdAt: at(5_000) });
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

  it('leaves a synthetic user turn unstamped and still returns the replies (#1892)', async () => {
    const alice = await seedContact(pool, 'synthetic-alice');
    await pool.query(
      `INSERT INTO contact_channel_identities (contact_id, channel, channel_identifier, source)
       VALUES ($1, 'signal', 'crh-1599-peer', 'manual')`,
      [alice],
    );
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const replyAt = new Date(now.getTime() + 1000);
    // The archived synthetic row is the shape that made this permanent: the
    // shared check has no archived filter and no time bound, so before #1892
    // this one row hid 'signal reply kept' forever.
    await pool.query(
      `INSERT INTO working_memory (conversation_id, agent_id, role, content, created_at, archived, sender_contact_id, channel_id, synthetic)
       VALUES
         ('signal:crh-1599-peer', 'coordinator', 'user', 'a Curia brief', $2, true, NULL, NULL, true),
         ('signal:crh-1599-peer', 'coordinator', 'user', 'real signal line', $2, true, NULL, NULL, false),
         ('signal:crh-1599-peer', 'coordinator', 'user', 'today on signal', $3, false, $1, 'signal', false),
         ('signal:crh-1599-peer', 'coordinator', 'assistant', 'signal reply kept', $4, false, NULL, 'signal', false)`,
      [alice, old, now, replyAt],
    );

    const stamped = await backfillDirectChannelSenders(pool, createLogger('error'), { batchSize: 10 });
    // Only the real human turn is stamped. syntheticRowsRemaining is the
    // table-wide standing total of unstamped synthetic Signal/SMS rows, so other
    // fixtures can add to it. This conversation contributes one.
    expect(stamped.signalRows).toBe(1);
    expect(stamped.syntheticRowsRemaining).toBeGreaterThanOrEqual(1);

    const senders = await pool.query<{ content: string; sender_contact_id: string | null }>(
      `SELECT content, sender_contact_id
       FROM working_memory
       WHERE conversation_id = 'signal:crh-1599-peer' AND role = 'user' AND archived = true
       ORDER BY content`,
      [],
    );
    const bySender = new Map(senders.rows.map(r => [r.content, r.sender_contact_id]));
    expect(bySender.get('real signal line')).toBe(alice);
    expect(bySender.get('a Curia brief')).toBeNull();

    // And the unstamped synthetic row does not close the thread to recall.
    const after = await memory.getContactRecentHistory({
      contactId: alice,
      agentId: 'coordinator',
      excludeConversationId: 'email:somewhere-else',
      since: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(after.map(t => t.content)).toEqual(['today on signal', 'signal reply kept']);
  });

  it("migration 092's repair clears a stamp 090 left on a synthetic row, idempotently (#1892)", async () => {
    // 092 has already run by the time this suite connects, so re-running its two
    // statements is the only way to exercise them. That is also what proves the
    // idempotency claim: a second application must be a no-op, because a database
    // that already ran 090 and a fresh one both reach this migration.
    const alice = await seedContact(pool, 'migration-091');
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Exactly the shape 090 leaves behind: briefs Curia wrote, each carrying the
    // human peer's contact id because the conversation-id pattern matched.
    // Both secret-capture wordings are here so the apostrophe in the LIKE pattern
    // is executed as a bound parameter, not only matched as migration source.
    const briefs = [
      VOICE_GREETING_USER_MESSAGE,
      `${CONTENT_BLOCK_REWRITE_MARKER}\n\nRewrite it.`,
      `${LATE_SPECIALIST_RESULT_MARKER}social-media, delivered 2026-09-20]\n\nDone.`,
      "The secret 'Aeroplan password' was just captured and saved to the vault. Original request: check the balance.",
      "The secret 'Aeroplan password' that a specialist asked for was just captured and saved to the vault. The specialist 'calendar' paused waiting for it.",
    ];
    const untouched = [
      'a real line',
      "The secret 'plan' was discussed yesterday.",
    ];
    const contents = [...briefs, ...untouched];
    await pool.query(
      `INSERT INTO working_memory (conversation_id, agent_id, role, content, created_at, archived, sender_contact_id, channel_id, synthetic)
       SELECT 'signal:crh-1599-peer', 'coordinator', 'user', content, $2, true, $1, 'signal', false
       FROM unnest($3::text[]) AS content`,
      [alice, old, contents],
    );

    const classify = `
      UPDATE working_memory SET synthetic = true
      WHERE role = 'user' AND synthetic = false
        AND content LIKE $1
        AND conversation_id = 'signal:crh-1599-peer'`;
    const clear = `
      UPDATE working_memory SET sender_contact_id = NULL
      WHERE role = 'user' AND synthetic = true AND sender_contact_id IS NOT NULL
        AND conversation_id = 'signal:crh-1599-peer'`;

    let classified = 0;
    for (const pattern of HISTORICAL_SYNTHETIC_LIKE_PATTERNS) {
      const result = await pool.query(classify, [pattern]);
      classified += result.rowCount ?? 0;
    }
    expect(classified).toBe(briefs.length);
    const cleared = await pool.query(clear);
    expect(cleared.rowCount).toBe(briefs.length);

    const rows = await pool.query<{ content: string; sender_contact_id: string | null; synthetic: boolean }>(
      `SELECT content, sender_contact_id, synthetic FROM working_memory
       WHERE conversation_id = 'signal:crh-1599-peer' AND role = 'user'`,
    );
    const byContent = new Map(rows.rows.map(r => [r.content, r]));
    for (const brief of briefs) {
      expect(byContent.get(brief)?.sender_contact_id).toBeNull();
      expect(byContent.get(brief)?.synthetic).toBe(true);
    }
    for (const line of untouched) {
      expect(byContent.get(line)?.sender_contact_id).toBe(alice);
      expect(byContent.get(line)?.synthetic).toBe(false);
    }

    // Second application touches nothing.
    for (const pattern of HISTORICAL_SYNTHETIC_LIKE_PATTERNS) {
      expect((await pool.query(classify, [pattern])).rowCount).toBe(0);
    }
    expect((await pool.query(clear)).rowCount).toBe(0);
  });

  it('plans the widest window on idx_wm_sender_active with a created_at bound', async () => {
    const widest = Math.max(...Object.values(CHANNEL_RECENT_HISTORY_HOURS));
    // Hold the contact row until EXPLAIN finishes. contacts.test.ts and
    // knowledge-graph.test.ts DELETE FROM contacts with no prefix in afterAll,
    // and vitest runs files in parallel. A committed contact can vanish during
    // this insert: RI checks the current row, so a later tuple in the same
    // statement fails the FK (#1892).
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const seeded = await client.query<{ id: string }>(
        `INSERT INTO contacts (display_name) VALUES ($1) RETURNING id`,
        [`${PREFIX}explain-alice`],
      );
      const alice = seeded.rows[0]?.id;
      if (!alice) throw new Error('explain-alice: INSERT INTO contacts returned no rows');
      // The queried contact owns the rows, spread over 30 days. sender_contact_id
      // equality matches all of them; only the created_at range stays selective.
      await client.query(
        `INSERT INTO working_memory (
           conversation_id, agent_id, role, content, created_at, archived, sender_contact_id, channel_id
         )
         SELECT
           $1 || 'explain:' || (g % 800),
           'coordinator',
           'user',
           'filler',
           now() - ((g % 720) || ' hours')::interval,
           false,
           $2::uuid,
           'email'
         FROM generate_series(1, 20000) g`,
        [PREFIX, alice],
      );
      await client.query('ANALYZE working_memory');

      const since = new Date(Date.now() - widest * 60 * 60 * 1000);
      const explained = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${CONTACT_RECENT_HISTORY_SQL}`,
        [alice, 'coordinator', since, `${PREFIX}explain:live`, 8],
      );
      const plan = explained.rows[0]?.['QUERY PLAN'];
      // A few thousand in-window rows often plan as a bitmap scan. Either node
      // type is the index, and both carry the time bound in Index Cond. A plan
      // that ignores created_at fails this even if it still names the index.
      const scan = findPlanNode(
        plan,
        (node) => (node['Node Type'] === 'Index Scan' || node['Node Type'] === 'Bitmap Index Scan')
          && node['Index Name'] === 'idx_wm_sender_active',
      );
      expect(scan, JSON.stringify(plan)).toBeDefined();
      expect(String(scan?.['Index Cond'])).toContain('created_at');
      await client.query('COMMIT');
      committed = true;
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr], 'plan test failed and rollback failed');
        }
      }
      throw err;
    } finally {
      client.release();
    }
  });
});

function findPlanNode(
  plan: unknown,
  predicate: (node: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  const visit = (node: unknown): Record<string, unknown> | undefined => {
    if (node == null || typeof node !== 'object') return undefined;
    const record = node as Record<string, unknown>;
    if (predicate(record)) return record;
    const children = record['Plans'];
    if (!Array.isArray(children)) return undefined;
    for (const child of children) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  if (!Array.isArray(plan)) return undefined;
  for (const entry of plan) {
    if (entry != null && typeof entry === 'object' && 'Plan' in entry) {
      const found = visit((entry as { Plan: unknown }).Plan);
      if (found) return found;
    }
  }
  return undefined;
}
