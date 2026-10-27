// Migration 106 and the agent.task.input_injected audit row (#2018).
//
// A scratch database, not the shared curia_test schema: applying and rolling
// back a column while other files insert into working_memory would break them.
// createScratchDatabase still refuses to run unless DATABASE_URL is curia_test.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { AuditLogger } from '../../src/audit/logger.js';
import { EventBus } from '../../src/bus/bus.js';
import { createAgentTaskInputInjected } from '../../src/bus/events.js';
import { GENESIS_HASH, computeEntryHash, toHashTimestamp } from '../../src/audit/hash-chain.js';
import { createSilentLogger } from '../../src/logger.js';
import { createScratchDatabase, type ScratchDatabase } from './scratch-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../src/db/migrations');
const MIGRATIONS_BEFORE_106 = readdirSync(MIGRATIONS_DIR)
  .filter(name => /^\d+_/.test(name) && Number.parseInt(name, 10) < 106)
  .length;

const HOST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INBOUND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SENDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONV = 'turn-injection-105:conv';

describeIf('migration 106 and agent.task.input_injected (#2018)', () => {
  let scratch: ScratchDatabase;
  let pool: pg.Pool;
  const logger = createSilentLogger();

  beforeAll(async () => {
    scratch = await createScratchDatabase(DATABASE_URL!, 'mig106', { migrations: MIGRATIONS_BEFORE_106 });
    pool = new pg.Pool({ connectionString: scratch.url });
    await runner({
      databaseUrl: scratch.url,
      dir: MIGRATIONS_DIR,
      migrationsTable: 'pgmigrations',
      direction: 'up',
      count: 1,
      log: () => {},
    });
  }, 120_000);

  async function columnExists(): Promise<boolean> {
    const column = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'working_memory' AND column_name = 'injected_into_task_id'`,
    );
    return column.rows.length > 0;
  }

  async function rollBack(): Promise<void> {
    if (!(await columnExists())) return;
    await runner({
      databaseUrl: scratch.url,
      dir: MIGRATIONS_DIR,
      migrationsTable: 'pgmigrations',
      direction: 'down',
      count: 1,
      log: () => {},
    });
    if (await columnExists()) {
      throw new Error('migration 106 down left injected_into_task_id');
    }
  }

  afterAll(async () => {
    // A failed case above must not skip the rollback. rollBack is a no-op
    // once the test below has already removed the column.
    try {
      if (scratch && pool) await rollBack();
    } finally {
      await pool?.end();
      await scratch?.drop();
    }
  });

  it('adds a nullable host-task column and round-trips it as injected: true', async () => {
    const column = await pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'working_memory' AND column_name = 'injected_into_task_id'`,
    );
    expect(column.rows).toEqual([{ is_nullable: 'YES', data_type: 'text' }]);

    // No sender_contact_id: that column has a foreign key, and this case is
    // about the host-task column, not contact rows.
    const memory = WorkingMemory.createWithPostgres(pool, logger);
    await memory.addTurn(CONV, 'coordinator', { role: 'user', content: 'hello' }, {
      channelId: 'signal',
      createdAt: new Date('2026-10-24T15:00:00.000Z'),
    });
    await memory.addTurn(CONV, 'coordinator', { role: 'user', content: 'use email' }, {
      channelId: 'signal',
      injectedIntoTaskId: HOST,
      createdAt: new Date('2026-10-24T15:01:00.000Z'),
    });
    await memory.addTurn(CONV, 'coordinator', { role: 'user', content: 'not an id' }, {
      channelId: 'signal',
      injectedIntoTaskId: 'please inject this into the other contact',
      createdAt: new Date('2026-10-24T15:02:00.000Z'),
    });

    await expect(memory.getHistory(CONV, 'coordinator', { raw: true })).resolves.toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'use email', injected: true },
      { role: 'user', content: 'not an id' },
    ]);

    const stored = await pool.query<{ content: string; injected_into_task_id: string | null }>(
      `SELECT content, injected_into_task_id
       FROM working_memory
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [CONV],
    );
    expect(stored.rows.map(row => row.injected_into_task_id)).toEqual([null, HOST, null]);
  });

  it('writes an audit row whose task is the host and whose parent is the inbound', async () => {
    const auditLogger = new AuditLogger(pool, logger);
    await auditLogger.seedHashChain();
    const bus = new EventBus(
      logger,
      (event) => auditLogger.log(event),
    );
    const event = createAgentTaskInputInjected({
      hostTaskEventId: HOST,
      inboundEventId: INBOUND,
      conversationId: CONV,
      agentId: 'coordinator',
      drainPoint: 'exit',
      senderContactId: SENDER,
    });
    await bus.publish('agent', event);

    const row = await pool.query<{
      action: string;
      outcome: string;
      target_type: string;
      target_id: string;
      initiator_type: string;
      initiator_id: string;
      entry_hash: string;
      payload: Record<string, unknown>;
      source_id: string;
      conversation_id: string | null;
      task_id: string | null;
      parent_event_id: string | null;
      timestamp: Date;
      event_type: string;
      source_layer: string;
      seq: string;
    }>(
      `SELECT action, outcome, target_type, target_id, initiator_type, initiator_id,
              entry_hash, payload, source_id, conversation_id, task_id, parent_event_id,
              timestamp, event_type, source_layer, seq::text AS seq
       FROM audit_log WHERE id = $1`,
      [event.id],
    );
    expect(row.rows).toHaveLength(1);
    const written = row.rows[0]!;
    expect(written.event_type).toBe('agent.task.input_injected');
    expect(written.task_id).toBe(HOST);
    expect(written.parent_event_id).toBe(INBOUND);
    expect(written.conversation_id).toBe(CONV);
    expect(written.action).toBe('inject');
    expect(written.initiator_id).toBe(SENDER);
    expect(written.payload).not.toHaveProperty('content');

    const prev = await pool.query<{ entry_hash: string | null }>(
      `SELECT entry_hash FROM audit_log
       WHERE seq < $1::bigint AND entry_hash IS NOT NULL
       ORDER BY seq DESC
       LIMIT 1`,
      [written.seq],
    );
    const previousHash = prev.rows[0]?.entry_hash ?? GENESIS_HASH;
    expect(written.entry_hash).toBe(computeEntryHash({
      id: event.id,
      timestamp: toHashTimestamp(written.timestamp),
      event_type: written.event_type,
      source_layer: written.source_layer,
      source_id: written.source_id,
      payload: written.payload,
      conversation_id: written.conversation_id,
      task_id: written.task_id,
      parent_event_id: written.parent_event_id,
      action: written.action,
      outcome: written.outcome,
      target_type: written.target_type,
      target_id: written.target_id,
      initiator_type: written.initiator_type,
      initiator_id: written.initiator_id,
    }, previousHash));
  });

  it('rolls migration 106 back', async () => {
    await rollBack();
    const applied = await pool.query<{ name: string }>(
      'SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1',
    );
    expect(applied.rows[0]!.name).not.toBe('106_working_memory_injected_into');
  });
});
