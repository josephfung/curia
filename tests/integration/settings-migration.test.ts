// Migration 132 takes setup_state apart into the settings store (#2709). These run on scratch
// databases migrated only to 130 (001–130), so setup_state still exists and 132 has not run.
// Each scenario gets its own database: 132 applies once, and its own copy runs as it would on
// an install upgrading from 130.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createScratchDatabase } from './scratch-database.js';
import { createSilentLogger } from '../../src/logger.js';
import { readSetupState } from '../../src/setup/setup-settings.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../src/db/migrations');

async function migrateToLatest(databaseUrl: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: () => { /* per-migration lines are noise in test output */ },
  });
}

describeIf('migration 132 — setup_state becomes settings', () => {
  it('leaves a pre-Setup-page install complete with no operator', async () => {
    const scratch = await createScratchDatabase(DATABASE_URL!, 'settings_legacy', { migrations: 130 });
    const pool = new pg.Pool({ connectionString: scratch.url });
    try {
      // What migration 130 left on an install that predates the Setup page.
      await pool.query(`INSERT INTO setup_state (id, phase) VALUES (1, 'complete')`);
      await migrateToLatest(scratch.url);

      const { rows } = await pool.query('SELECT key, value, updated_by FROM settings ORDER BY key');
      expect(rows.map((row) => row.key)).toEqual(['setup.completed_at']);
      const completedAt = rows[0]?.value;
      expect(typeof completedAt).toBe('string');
      expect(Number.isNaN(Date.parse(completedAt as string))).toBe(false);
      // Its own actor, so it reads as complete but not as a completion on the Setup page.
      expect(rows[0]?.updated_by).toBe('migration:132:pre-setup-page');
      expect(await readSetupState(pool, createSilentLogger())).toMatchObject({
        phase: 'complete',
        completedOnPage: false,
      });

      const gone = await pool.query(`SELECT to_regclass('setup_state') AS relation`);
      expect(gone.rows[0]).toEqual({ relation: null });
    } finally {
      await pool.end();
      await scratch.drop();
    }
  });

  it('copies the operator, the routes and the completion time, then drops setup_state', async () => {
    const scratch = await createScratchDatabase(DATABASE_URL!, 'settings_full', { migrations: 130 });
    const pool = new pg.Pool({ connectionString: scratch.url });
    try {
      await pool.query(
        `INSERT INTO setup_state
           (id, phase, setup_for, operator_name, operator_email, messaging_route, voice_route, completed_at)
         VALUES (1, 'complete', 'other', '  Sam  ', 'Sam@Example.com', 'signal', 'app', '2026-02-03T04:05:06Z')`,
      );
      await migrateToLatest(scratch.url);

      const { rows } = await pool.query('SELECT key, value, updated_by FROM settings ORDER BY key');
      const byKey = new Map(rows.map((row) => [row.key, row.value]));
      expect(byKey.get('operator')).toEqual({ name: 'Sam', email: 'sam@example.com' });
      expect(byKey.get('messaging_route')).toBe('signal');
      expect(byKey.get('voice_route')).toBe('app');
      expect(byKey.get('setup.completed_at')).toBe('2026-02-03T04:05:06.000Z');
      for (const row of rows) expect(row.updated_by).toBe('migration:132');
      // A Setup the page finished before the upgrade is still a page completion afterwards.
      expect(await readSetupState(pool, createSilentLogger())).toMatchObject({
        phase: 'complete',
        completedOnPage: true,
      });
    } finally {
      await pool.end();
      await scratch.drop();
    }
  });

  it('does not copy leftover operator fields from a "myself" install', async () => {
    const scratch = await createScratchDatabase(DATABASE_URL!, 'settings_self', { migrations: 130 });
    const pool = new pg.Pool({ connectionString: scratch.url });
    try {
      // The old page allowed a half-save, so a "myself" row can still carry a name and email.
      await pool.query(
        `INSERT INTO setup_state
           (id, phase, setup_for, operator_name, operator_email, messaging_route, voice_route)
         VALUES (1, 'in_progress', 'self', 'Stale Operator', 'stale@example.com', 'app', NULL)`,
      );
      await migrateToLatest(scratch.url);

      const { rows } = await pool.query('SELECT key FROM settings ORDER BY key');
      expect(rows.map((row) => row.key)).toEqual(['messaging_route']);
    } finally {
      await pool.end();
      await scratch.drop();
    }
  });
});
