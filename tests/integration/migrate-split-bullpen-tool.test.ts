// Integration test — runs the 097 migration's Up and Down SQL against a live Postgres and
// asserts the old `bullpen` tool row becomes the `bullpen` bundle and its four tools, and
// back (#2126). Skips without DATABASE_URL.
//
// Each case runs inside a transaction on one client and is rolled back, so registry rows
// already in the database, and their timestamps, are never changed. It still deletes and
// locks rows inside that transaction, so it refuses any database but curia_test first.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const MIGRATION_SQL_URL = new URL('../../src/db/migrations/097_split_bullpen_tool.sql', import.meta.url);
const NEW_TOOLS = ['bullpen-post', 'bullpen-reply', 'bullpen-read', 'bullpen-close'];
const TOOL_NAMES = ['bullpen', ...NEW_TOOLS];

interface Row {
  name: string;
  enabled: boolean;
  installed_by: string;
  enabled_by: string | null;
}

describeIf('migration 097: split the bullpen tool', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let upSql: string;
  let downSql: string;

  async function toolRows(): Promise<Row[]> {
    const { rows } = await client.query<Row>(
      'SELECT name, enabled, installed_by, enabled_by FROM tool_registry WHERE name = ANY($1) ORDER BY name',
      [TOOL_NAMES],
    );
    return rows;
  }

  async function skillRow(): Promise<Row | undefined> {
    const { rows } = await client.query<Row>(
      "SELECT name, enabled, installed_by, enabled_by FROM skill_registry WHERE name = 'bullpen'",
    );
    return rows[0];
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // Before any case opens a transaction. afterAll still runs if this throws, and only
    // closes the pool.
    await requireCuriaTestDatabase(pool);
    const sql = await readFile(MIGRATION_SQL_URL, 'utf8');
    const [up, down] = sql.split('-- Down Migration');
    upSql = up!;
    downSql = down!;
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    // A clean slate inside the transaction only; the rollback below restores it.
    await client.query('DELETE FROM tool_registry WHERE name = ANY($1)', [TOOL_NAMES]);
    await client.query("DELETE FROM skill_registry WHERE name = 'bullpen'");
  });

  afterEach(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('moves an enabled bullpen row to the bundle and its four tools, and drops it', async () => {
    await client.query(
      "INSERT INTO tool_registry (name, enabled, installed_by, enabled_at, enabled_by) VALUES ('bullpen', true, 'reconciliation', now(), 'reconciliation')",
    );
    await client.query(upSql);

    const tools = await toolRows();
    expect(tools.map(r => r.name)).toEqual([...NEW_TOOLS].sort());
    expect(tools.every(r => r.enabled && r.installed_by === 'migration:097' && r.enabled_by === 'reconciliation')).toBe(true);
    expect(await skillRow()).toMatchObject({ enabled: true, installed_by: 'migration:097', enabled_by: 'reconciliation' });
  });

  it("keeps an admin's disable", async () => {
    await client.query(
      "INSERT INTO tool_registry (name, enabled, installed_by) VALUES ('bullpen', false, 'web-app')",
    );
    await client.query(upSql);

    const tools = await toolRows();
    expect(tools).toHaveLength(4);
    expect(tools.every(r => !r.enabled)).toBe(true);
    expect(await skillRow()).toMatchObject({ enabled: false });
  });

  it('seeds the tools from a bullpen skill row that already existed, so they agree', async () => {
    await client.query(
      "INSERT INTO tool_registry (name, enabled, installed_by) VALUES ('bullpen', true, 'reconciliation')",
    );
    await client.query(
      "INSERT INTO skill_registry (name, enabled, installed_by) VALUES ('bullpen', false, 'web-app')",
    );
    await client.query(upSql);

    expect(await skillRow()).toMatchObject({ enabled: false, installed_by: 'web-app' });
    const tools = await toolRows();
    expect(tools.map(r => r.name)).toEqual([...NEW_TOOLS].sort());
    expect(tools.every(r => !r.enabled)).toBe(true);
  });

  it('does nothing on a fresh install', async () => {
    await client.query(upSql);
    expect(await toolRows()).toEqual([]);
    expect(await skillRow()).toBeUndefined();
  });

  it('leaves an existing row for a new name alone', async () => {
    await client.query(
      "INSERT INTO tool_registry (name, enabled, installed_by) VALUES ('bullpen', true, 'reconciliation')",
    );
    await client.query(
      "INSERT INTO tool_registry (name, enabled, installed_by) VALUES ('bullpen-close', false, 'web-app')",
    );
    await client.query(upSql);

    const close = (await toolRows()).find(r => r.name === 'bullpen-close');
    expect(close).toMatchObject({ enabled: false, installed_by: 'web-app' });
    expect((await toolRows()).map(r => r.name)).not.toContain('bullpen');
  });

  it('down restores the bullpen row and removes only the rows up created', async () => {
    await client.query(
      "INSERT INTO tool_registry (name, enabled, installed_by) VALUES ('bullpen', false, 'web-app')",
    );
    await client.query(
      "INSERT INTO tool_registry (name, enabled, installed_by) VALUES ('bullpen-close', true, 'web-app')",
    );
    await client.query(upSql);
    await client.query(downSql);

    const tools = await toolRows();
    expect(tools.map(r => r.name)).toEqual(['bullpen', 'bullpen-close']);
    expect(tools.find(r => r.name === 'bullpen')).toMatchObject({ enabled: false });
    // Not created by up, so down leaves it with its own state.
    expect(tools.find(r => r.name === 'bullpen-close')).toMatchObject({ enabled: true, installed_by: 'web-app' });
    expect(await skillRow()).toBeUndefined();
  });
});
