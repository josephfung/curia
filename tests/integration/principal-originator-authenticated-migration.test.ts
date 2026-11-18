// Migration 128 makes `authenticated` explicit on stored principal originators (GHSA-p49r-jqh2-v668).
//
// The test database has already run every migration, so this file seeds rows the way they looked
// before it, runs the migration's Up section inside a transaction, reads the result and rolls back:
// the backfill is global, and integration files share one database.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

const MIGRATION = fs.readFileSync(
  path.join(import.meta.dirname, '../../src/db/migrations/128_principal_originator_authenticated.sql'),
  'utf8',
);
const UP = MIGRATION.split('-- Up Migration')[1]!.split('-- Down Migration')[0]!;

const originator = (systemRole: string | null, channel: string | undefined, authenticated?: boolean) => ({
  contactId: 'c-1', systemRole, ...(channel !== undefined ? { channel } : {}), initiatedAt: '2026-10-01T00:00:00Z', tier: systemRole === 'principal' ? 'principal' : 'trusted',
  ...(authenticated !== undefined ? { authenticated } : {}),
});

describe('migration 128 covers every stored originator', () => {
  it.each(['scheduled_jobs', 'tasks', 'bullpen_threads', 'pending_delegations', 'secret_capture_tokens', 'task_outreach'])('updates %s', (table) => {
    expect(UP).toContain(`UPDATE ${table} SET originator`);
  });
});

describeIf('migration 128: principal originator authenticated backfill', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('sets the flag by channel, fixes stored voice, and leaves the rest alone', async () => {
    const cases: Array<[string, Record<string, unknown>, boolean | undefined]> = [
      ['signal, missing', originator('principal', 'signal'), true],
      ['console, missing', originator('principal', 'console'), true],
      ['email, missing', originator('principal', 'email'), false],
      ['sms, missing', originator('principal', 'sms'), false],
      ['voice, false', originator('principal', 'voice', false), true],
      ['web, false', originator('principal', 'web', false), true],
      ['cli, false', originator('principal', 'cli', false), true],
      // jsonb_set is strict: without COALESCE a missing channel would null the whole originator.
      ['no channel, missing', originator('principal', undefined), false],
      ['email, true', originator('principal', 'email', true), true],
      ['email, false', originator('principal', 'email', false), false],
      ['trusted contact, missing', originator(null, 'email'), undefined],
    ];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids: Record<string, string> = {};
      for (const [label, o] of cases) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO scheduled_jobs (agent_id, source_agent_id, cron_expr, task_payload, status, next_run_at, created_by, timezone, originator)
           VALUES ('coordinator', 'coordinator', '0 9 * * *', $2::jsonb, 'pending', now() + interval '1 day', 'system', 'UTC', $1)
           RETURNING id`,
          // A payload per case: system jobs are unique on agent, cron and payload (scheduled_jobs_declarative_uq).
          [JSON.stringify(o), JSON.stringify({ case: label })],
        );
        ids[label] = rows[0]!.id;
      }
      const { rows: taskRows } = await client.query<{ id: string }>(
        `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, created_by, tags, updated_at, originator)
         VALUES ('coordinator', 'migration 128', 'seeded', 'open', '{}'::jsonb, '{}'::jsonb, 'ceo', 50, 'agent', 'test', '{}', now(), $1)
         RETURNING id`,
        [JSON.stringify(originator('principal', 'sms'))],
      );

      await client.query(UP);

      for (const [label, , expected] of cases) {
        const { rows } = await client.query<{ originator: Record<string, unknown> }>('SELECT originator FROM scheduled_jobs WHERE id = $1', [ids[label]]);
        expect(rows[0]!.originator['authenticated'], label).toBe(expected);
      }
      const { rows: task } = await client.query<{ originator: Record<string, unknown> }>('SELECT originator FROM tasks WHERE id = $1', [taskRows[0]!.id]);
      expect(task[0]!.originator['authenticated']).toBe(false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
