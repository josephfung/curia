// contact-timezone-repair.test.ts — the boot-time repair against real Postgres.
//
// A Google Calendar invite footer ("Eastern Time - Toronto") was stored as a principal's
// timezone and inbox triage threw on every tick. repairStoredTimezones() maps such labels at
// boot. The unit test covers the decisions; this covers the SQL against the real table.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { repairStoredTimezones } from '../../src/contacts/timezone-repair.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('repairStoredTimezones (Postgres)', () => {
  let pool: pg.Pool;
  // Set only once the database guard passes, so cleanup never runs against a mispointed DB.
  let onTestDb = false;
  const createdContactIds: string[] = [];

  async function makeContact(timezone: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO contacts (display_name, timezone) VALUES ($1, $2) RETURNING id`,
      ['Timezone Repair Fixture', timezone],
    );
    const id = rows[0]!.id;
    createdContactIds.push(id);
    return id;
  }

  async function timezoneOf(id: string): Promise<string | null> {
    const { rows } = await pool.query<{ timezone: string | null }>('SELECT timezone FROM contacts WHERE id = $1', [id]);
    return rows[0]!.timezone;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // The repair reads every contact row and updates the invalid ones: table-wide.
    await requireCuriaTestDatabase(pool);
    onTestDb = true;
  });

  afterEach(async () => {
    if (onTestDb && createdContactIds.length > 0) {
      await pool.query('DELETE FROM contacts WHERE id = ANY($1::uuid[])', [createdContactIds]);
      createdContactIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('maps a label, keeps valid and unmappable values, and is idempotent', async () => {
    const label = await makeContact('Eastern Time - Toronto');
    const valid = await makeContact('Europe/London');
    const unmappable = await makeContact('Eastern Time - US & Canada');
    const none = await makeContact(null);

    const first = await repairStoredTimezones(pool, createSilentLogger());

    expect(await timezoneOf(label)).toBe('America/Toronto');
    expect(await timezoneOf(valid)).toBe('Europe/London');
    expect(await timezoneOf(unmappable)).toBe('Eastern Time - US & Canada');
    expect(await timezoneOf(none)).toBeNull();
    // Other suites may leave rows behind, so count at least ours.
    expect(first.repaired).toBeGreaterThanOrEqual(1);
    expect(first.unrecognized).toBeGreaterThanOrEqual(1);

    const second = await repairStoredTimezones(pool, createSilentLogger());
    expect(second.repaired).toBe(0);
    expect(await timezoneOf(label)).toBe('America/Toronto');
  });
});
