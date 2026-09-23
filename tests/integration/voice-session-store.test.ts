// Integration tests for VoiceSessionStore — requires Postgres with migration 089 applied.
// Skips gracefully when DATABASE_URL is unset. CI boots Postgres, migrates, and sets it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { VoiceSessionStore } from '../../src/channels/voice/session-store.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'voice-store-test:';

async function seedContact(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO contacts (display_name) VALUES ($1) RETURNING id`,
    [`${PREFIX}contact`],
  );
  const row = rows[0];
  if (!row) throw new Error('seedContact: INSERT INTO contacts returned no rows');
  return row.id;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM voice_sessions WHERE conversation_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM contacts WHERE display_name LIKE $1`, [`${PREFIX}%`]);
}

describeIf('VoiceSessionStore (integration)', () => {
  let pool: pg.Pool;
  let store: VoiceSessionStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Fails loudly if migration 082/089 is missing — the column name is the thing under test.
    await pool.query('SELECT caller_contact_id FROM voice_sessions LIMIT 0');
    store = new VoiceSessionStore(pool);
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

  it('create round-trips a real caller contact id', async () => {
    const contactId = await seedContact(pool);
    const created = await store.create({
      conversationId: `${PREFIX}round-trip`,
      livekitRoom: 'room-round-trip',
      callerContactId: contactId,
    });
    expect(created.callerContactId).toBe(contactId);
    expect(created.status).toBe('starting');
  });

  it('create stores null when callerContactId is omitted', async () => {
    const created = await store.create({
      conversationId: `${PREFIX}null-caller`,
      livekitRoom: 'room-null-caller',
    });
    expect(created.callerContactId).toBeNull();
  });

  it('get reads the persisted caller contact id', async () => {
    const contactId = await seedContact(pool);
    const created = await store.create({
      conversationId: `${PREFIX}get`,
      livekitRoom: 'room-get',
      callerContactId: contactId,
    });
    const fetched = await store.get(created.id);
    expect(fetched?.callerContactId).toBe(contactId);
    expect(fetched?.conversationId).toBe(`${PREFIX}get`);
  });

  it('updateStatus returns the caller contact id from its own RETURNING list', async () => {
    const contactId = await seedContact(pool);
    const created = await store.create({
      conversationId: `${PREFIX}status`,
      livekitRoom: 'room-status',
      callerContactId: contactId,
    });
    const updated = await store.updateStatus(created.id, 'active');
    expect(updated?.status).toBe('active');
    expect(updated?.callerContactId).toBe(contactId);
  });

  it('endSession returns the caller contact id from its own RETURNING list', async () => {
    const contactId = await seedContact(pool);
    const created = await store.create({
      conversationId: `${PREFIX}end`,
      livekitRoom: 'room-end',
      callerContactId: contactId,
    });
    const ended = await store.endSession(created.id, 'hangup');
    expect(ended?.status).toBe('ended');
    expect(ended?.endReason).toBe('hangup');
    expect(ended?.callerContactId).toBe(contactId);
    expect(ended?.endedAt).toBeInstanceOf(Date);
  });

  it('names the caller foreign key caller_contact_id and keeps ON DELETE SET NULL', async () => {
    const { rows } = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
       FROM pg_constraint
       WHERE conrelid = 'voice_sessions'::regclass
         AND contype = 'f'`,
    );
    const names = rows.map((row) => row.conname);
    expect(names).toContain('voice_sessions_caller_contact_id_fkey');
    expect(names).not.toContain('voice_sessions_principal_contact_id_fkey');
    const fk = rows.find((row) => row.conname === 'voice_sessions_caller_contact_id_fkey');
    expect(fk?.confdeltype).toBe('n');
  });

  it('re-applying the up migration is a no-op', async () => {
    const sql = readFileSync(
      join(import.meta.dirname, '../../src/db/migrations/089_rename_voice_session_caller_contact_id.sql'),
      'utf8',
    );
    const up = sql.split(/^-- Down Migration$/m)[0];
    if (!up?.includes('RENAME COLUMN')) throw new Error('failed to extract the up migration');
    await pool.query(up);
    await pool.query('SELECT caller_contact_id FROM voice_sessions LIMIT 0');
  });
});
