// tests/integration/channel-registry-repo.test.ts
// Requires Postgres with migration 052 applied. Skips when DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { ChannelRegistryRepo } from '../../src/registry/channel-registry-repo.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('ChannelRegistryRepo', () => {
  let pool: pg.Pool;
  let repo: ChannelRegistryRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM channel_registry LIMIT 0'); // fails loudly if migration 052 not applied
    repo = new ChannelRegistryRepo(pool);
  });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await pool.query('DELETE FROM channel_registry'); });

  it('install inserts a disabled row carrying is_toggleable', async () => {
    const row = await repo.install('signal', 'tester', true);
    expect(row.enabled).toBe(false);
    expect(row.isToggleable).toBe(true);
    expect(row.installedBy).toBe('tester');
    expect(row.enabledAt).toBeNull();
  });

  it('install is idempotent and preserves is_toggleable of the existing row', async () => {
    await repo.install('http', 'system', false);
    const again = await repo.install('http', 'someone', true); // should NOT flip to toggleable
    expect(again.isToggleable).toBe(false);
  });

  it('enable then disable toggles enabled + enabled_at', async () => {
    await repo.install('signal', 'tester', true);
    const enabled = await repo.enable('signal', 'admin');
    expect(enabled.enabled).toBe(true);
    expect(enabled.enabledAt).not.toBeNull();
    const disabled = await repo.disable('signal', 'admin');
    expect(disabled.enabled).toBe(false);
    expect(disabled.enabledAt).toBeNull();
  });

  it('uninstall removes the row', async () => {
    await repo.install('signal', 'tester', true);
    await repo.uninstall('signal');
    expect(await repo.getRow('signal')).toBeNull();
  });
});
