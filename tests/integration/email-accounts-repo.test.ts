// Integration tests for EmailAccountsRepo — requires Postgres with migration 064 applied.
// Skips gracefully when DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { EmailAccountsRepo } from '../../src/channels/email/email-accounts-repo.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('EmailAccountsRepo (integration)', () => {
  let pool: pg.Pool;
  let repo: EmailAccountsRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM email_accounts LIMIT 0'); // fails loudly if migration 064 not applied
    repo = new EmailAccountsRepo(pool);
  });
  afterAll(async () => {
    // Always close the pool, even if the cleanup DELETE throws (e.g. the table check in
    // beforeAll already failed) — otherwise the pool leaks connections and can hang the run.
    try {
      await pool.query('DELETE FROM email_accounts');
    } finally {
      await pool.end();
    }
  });
  beforeEach(async () => { await pool.query('DELETE FROM email_accounts'); });

  it('starts empty', async () => {
    expect(await repo.count()).toBe(0);
    expect(await repo.list()).toEqual([]);
  });

  it('creates and reads back an account with defaults', async () => {
    const row = await repo.create({ name: 'curia', selfEmail: 'curia@example.com' });
    expect(row.name).toBe('curia');
    expect(row.selfEmail).toBe('curia@example.com');
    expect(row.provider).toBe('nylas');
    expect(row.enabled).toBe(true);
    expect(row.createdBy).toBe('web-console');
    expect(await repo.count()).toBe(1);
    expect((await repo.get('curia'))?.selfEmail).toBe('curia@example.com');
  });

  it('updates self_email and enabled', async () => {
    await repo.create({ name: 'curia', selfEmail: 'a@example.com' });
    const updated = await repo.update('curia', { selfEmail: 'b@example.com', enabled: false });
    expect(updated?.selfEmail).toBe('b@example.com');
    expect(updated?.enabled).toBe(false);
  });

  it('update of a missing row returns null', async () => {
    expect(await repo.update('nope', { enabled: false })).toBeNull();
  });

  it('deletes', async () => {
    await repo.create({ name: 'curia', selfEmail: 'a@example.com' });
    expect(await repo.delete('curia')).toBe(true);
    expect(await repo.delete('curia')).toBe(false);
    expect(await repo.count()).toBe(0);
  });

  it('list returns rows ordered by name', async () => {
    await repo.create({ name: 'beta', selfEmail: 'b@example.com' });
    await repo.create({ name: 'alpha', selfEmail: 'a@example.com' });
    expect((await repo.list()).map(r => r.name)).toEqual(['alpha', 'beta']);
  });
});
