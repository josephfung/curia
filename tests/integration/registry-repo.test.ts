// Integration tests for RegistryRepo — requires Postgres with migrations applied.
// Skips gracefully when DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { RegistryRepo } from '../../src/registry/registry-repo.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('RegistryRepo (skill_registry)', () => {
  let pool: pg.Pool;
  let repo: RegistryRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM skill_registry LIMIT 0'); // fails loudly if migration 051 not applied
    repo = new RegistryRepo(pool, 'skill_registry');
  });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await pool.query('DELETE FROM skill_registry'); });

  it('install inserts a disabled row with installed_by', async () => {
    const row = await repo.install('alpha', 'tester');
    expect(row.enabled).toBe(false);
    expect(row.installedBy).toBe('tester');
    expect(row.enabledAt).toBeNull();
  });

  it('install is idempotent — second call returns the same row', async () => {
    const first = await repo.install('alpha', 'tester');
    const second = await repo.install('alpha', 'someone-else');
    expect(second.installedBy).toBe(first.installedBy); // unchanged
  });

  it('enable sets enabled + enabled_at/by', async () => {
    await repo.install('alpha', 'tester');
    const row = await repo.enable('alpha', 'enabler');
    expect(row.enabled).toBe(true);
    expect(row.enabledBy).toBe('enabler');
    expect(row.enabledAt).not.toBeNull();
  });

  it('disable clears enabled_at/by', async () => {
    await repo.install('alpha', 'tester');
    await repo.enable('alpha', 'enabler');
    const row = await repo.disable('alpha', 'disabler');
    expect(row.enabled).toBe(false);
    expect(row.enabledAt).toBeNull();
    expect(row.enabledBy).toBeNull();
  });

  it('enable throws when no row exists', async () => {
    await expect(repo.enable('ghost', 'x')).rejects.toThrow(/no registry row/i);
  });

  it('uninstall deletes the row', async () => {
    await repo.install('alpha', 'tester');
    await repo.uninstall('alpha');
    expect(await repo.getRow('alpha')).toBeNull();
  });

  it('listRows returns all rows', async () => {
    await repo.install('alpha', 'tester');
    await repo.install('beta', 'tester');
    const rows = await repo.listRows();
    expect(rows.map(r => r.name).sort()).toEqual(['alpha', 'beta']);
  });
});
