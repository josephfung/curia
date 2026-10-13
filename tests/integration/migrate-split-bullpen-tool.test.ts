// Integration test — runs the 097 migration's Up SQL against a live Postgres and asserts
// the old `bullpen` tool row becomes the `bullpen` bundle and its four tools (#2126).
// Skips without DATABASE_URL.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

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
  let upSql: string;
  // These tests delete real registry rows, so restore whatever was there before.
  let savedTools: Row[] = [];
  let savedSkill: Row[] = [];

  async function toolRows(): Promise<Row[]> {
    const { rows } = await pool.query<Row>(
      'SELECT name, enabled, installed_by, enabled_by FROM tool_registry WHERE name = ANY($1) ORDER BY name',
      [TOOL_NAMES],
    );
    return rows;
  }

  async function skillRow(): Promise<Row | undefined> {
    const { rows } = await pool.query<Row>(
      "SELECT name, enabled, installed_by, enabled_by FROM skill_registry WHERE name = 'bullpen'",
    );
    return rows[0];
  }

  async function clear(): Promise<void> {
    await pool.query('DELETE FROM tool_registry WHERE name = ANY($1)', [TOOL_NAMES]);
    await pool.query("DELETE FROM skill_registry WHERE name = 'bullpen'");
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const sql = await readFile(MIGRATION_SQL_URL, 'utf8');
    upSql = sql.split('-- Down Migration')[0]!;
    savedTools = await toolRows();
    const skill = await skillRow();
    savedSkill = skill ? [skill] : [];
  });

  beforeEach(clear);

  afterAll(async () => {
    await clear();
    for (const row of savedTools) {
      await pool.query(
        'INSERT INTO tool_registry (name, enabled, installed_by, enabled_by) VALUES ($1, $2, $3, $4)',
        [row.name, row.enabled, row.installed_by, row.enabled_by],
      );
    }
    for (const row of savedSkill) {
      await pool.query(
        'INSERT INTO skill_registry (name, enabled, installed_by, enabled_by) VALUES ($1, $2, $3, $4)',
        [row.name, row.enabled, row.installed_by, row.enabled_by],
      );
    }
    await pool.end();
  });

  it('moves an enabled bullpen row to the bundle and its four tools, and drops it', async () => {
    await pool.query(
      "INSERT INTO tool_registry (name, enabled, installed_by, enabled_at, enabled_by) VALUES ('bullpen', true, 'reconciliation', now(), 'reconciliation')",
    );
    await pool.query(upSql);

    const tools = await toolRows();
    expect(tools.map(r => r.name)).toEqual([...NEW_TOOLS].sort());
    expect(tools.every(r => r.enabled && r.installed_by === 'reconciliation')).toBe(true);
    expect(await skillRow()).toMatchObject({ enabled: true, installed_by: 'reconciliation' });
  });

  it("keeps an admin's disable", async () => {
    await pool.query(
      "INSERT INTO tool_registry (name, enabled, installed_by) VALUES ('bullpen', false, 'web-app')",
    );
    await pool.query(upSql);

    const tools = await toolRows();
    expect(tools).toHaveLength(4);
    expect(tools.every(r => !r.enabled)).toBe(true);
    expect(await skillRow()).toMatchObject({ enabled: false, installed_by: 'web-app' });
  });

  it('does nothing on a fresh install', async () => {
    await pool.query(upSql);
    expect(await toolRows()).toEqual([]);
    expect(await skillRow()).toBeUndefined();
  });

  it('leaves an existing row for a new name alone', async () => {
    await pool.query(
      "INSERT INTO tool_registry (name, enabled, installed_by) VALUES ('bullpen', true, 'reconciliation')",
    );
    await pool.query(
      "INSERT INTO tool_registry (name, enabled, installed_by) VALUES ('bullpen-close', false, 'web-app')",
    );
    await pool.query(upSql);

    const close = (await toolRows()).find(r => r.name === 'bullpen-close');
    expect(close).toMatchObject({ enabled: false, installed_by: 'web-app' });
    expect((await toolRows()).map(r => r.name)).not.toContain('bullpen');
  });
});
