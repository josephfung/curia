// Integration test — constraints of the principal_mailboxes registry table (#2475, migrations 123-124).
// Skips without DATABASE_URL.
//
// The constraints are exercised on a TEMP copy of the table (LIKE ... INCLUDING ALL copies the
// checks, primary key and partial unique indexes). Integration files run in parallel on one
// database and the registry store test commits real rows, so inserting a live default into the
// real table here could collide with it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

async function insert(
  client: pg.PoolClient,
  id: string,
  address: string,
  opts: { isDefault?: boolean; removed?: boolean } = {},
): Promise<void> {
  await client.query(
    `INSERT INTO pg_temp.pm_test (id, label, address, is_default, removed_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, id, address, opts.isDefault ?? false, opts.removed ? new Date() : null],
  );
}

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describeIf('123_principal_mailboxes', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    client = await pool.connect();
    await client.query('CREATE TEMP TABLE pm_test (LIKE principal_mailboxes INCLUDING ALL)');
  });

  afterAll(async () => {
    // afterAll runs even when beforeAll throws, so the client may never have been taken.
    try {
      client?.release();
    } finally {
      await pool.end();
    }
  });

  it('rejects an empty or over-long label and one with control characters (124)', async () => {
    for (const label of ['', 'x'.repeat(81), 'Wo\nrk', 'Tab\there']) {
      const code = await pgCode(client.query(
        'INSERT INTO pg_temp.pm_test (id, label, address) VALUES ($1, $2, $3)',
        ['labelcheck', label, 'label-check@example.com'],
      ));
      expect(code, JSON.stringify(label)).toBe('23514');
    }
    await client.query('INSERT INTO pg_temp.pm_test (id, label, address) VALUES ($1, $2, $3)', ['labelok', 'Work (Acme) — ok', 'label-ok@example.com']);
    await client.query('DELETE FROM pg_temp.pm_test WHERE id IS NOT NULL');
  });

  it('allows one live default', async () => {
    await client.query('DELETE FROM pg_temp.pm_test WHERE id IS NOT NULL');
    await insert(client, 'work', 'a@example.com', { isDefault: true });
    expect(await pgCode(insert(client, 'personal', 'b@example.com', { isDefault: true }))).toBe('23505');
  });

  it('allows a removed default alongside a live one', async () => {
    await client.query('DELETE FROM pg_temp.pm_test WHERE id IS NOT NULL');
    await insert(client, 'work', 'a@example.com', { isDefault: true, removed: true });
    await insert(client, 'personal', 'b@example.com', { isDefault: true });
    const { rows } = await client.query('SELECT count(*)::int AS n FROM pg_temp.pm_test');
    expect(rows[0].n).toBe(2);
  });

  it('rejects a reused live address', async () => {
    await client.query('DELETE FROM pg_temp.pm_test WHERE id IS NOT NULL');
    await insert(client, 'work', 'a@example.com');
    expect(await pgCode(insert(client, 'personal', 'a@example.com'))).toBe('23505');
  });

  it('allows a removed row address to be reused', async () => {
    await client.query('DELETE FROM pg_temp.pm_test WHERE id IS NOT NULL');
    await insert(client, 'work', 'a@example.com', { removed: true });
    await insert(client, 'personal', 'a@example.com');
  });

  it('rejects id primary and default', async () => {
    await client.query('DELETE FROM pg_temp.pm_test WHERE id IS NOT NULL');
    expect(await pgCode(insert(client, 'primary', 'a@example.com'))).toBe('23514');
    expect(await pgCode(insert(client, 'default', 'b@example.com'))).toBe('23514');
  });

  it('rejects malformed ids and non-lowercase addresses', async () => {
    await client.query('DELETE FROM pg_temp.pm_test WHERE id IS NOT NULL');
    expect(await pgCode(insert(client, 'Work', 'a@example.com'))).toBe('23514');
    expect(await pgCode(insert(client, '1work', 'a@example.com'))).toBe('23514');
    expect(await pgCode(insert(client, 'work', 'A@example.com'))).toBe('23514');
  });

  it('keeps a removed row so its id cannot be inserted again', async () => {
    await client.query('DELETE FROM pg_temp.pm_test WHERE id IS NOT NULL');
    await insert(client, 'work', 'a@example.com', { removed: true });
    expect(await pgCode(insert(client, 'work', 'b@example.com'))).toBe('23505');
  });
});
