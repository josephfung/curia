// Integration test — the two migration tracks and the reconciliation that moves a fork's
// applied migrations onto the local one (#2465, ADR-061). Each case runs tiny fixture
// migrations in a scratch database of its own, so nothing here touches curia_test's schema.
// Skips without DATABASE_URL.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {
  dryRunReconciliation,
  MigrationReconciliationError,
  runMigrations,
  type MigrationDirs,
} from '../../src/db/run-migrations.js';
import { createScratchDatabase, type ScratchDatabase } from './scratch-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const SQL: Record<string, string> = {
  '001_core': 'CREATE TABLE IF NOT EXISTS core_a (id int PRIMARY KEY);',
  '002_core': 'CREATE TABLE IF NOT EXISTS core_b (id int PRIMARY KEY);',
  '003_core_new': 'CREATE TABLE IF NOT EXISTS core_new (id int PRIMARY KEY);',
  '004_core_later': 'CREATE TABLE IF NOT EXISTS core_later (id int PRIMARY KEY);',
  '000_core_early': 'SELECT 1;',
  '003_fork_a': 'CREATE TABLE IF NOT EXISTS fork_a (id int PRIMARY KEY);',
  // Depends on an upstream table: allowed for the local track.
  '004_fork_b': 'ALTER TABLE core_a ADD COLUMN fork_note text;',
  '005_fork_c': 'CREATE TABLE IF NOT EXISTS fork_c (id int PRIMARY KEY);',
  '001_fork_early': 'SELECT 1;',
};

describeIf('runMigrations: upstream and local tracks', () => {
  let scratch: ScratchDatabase;
  let pool: pg.Pool;
  let root: string;
  let dirs: MigrationDirs;

  /**
   * Puts exactly these fixture migrations in a directory, replacing what was there. The
   * local directory also gets a README, as the real one has.
   */
  function fill(dir: string, names: string[]): void {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    if (dir === dirs.local) writeFileSync(path.join(dir, 'README.md'), 'Not a migration.');
    for (const name of names) writeFileSync(path.join(dir, `${name}.sql`), SQL[name]!);
  }

  function migrate() {
    return runMigrations({ databaseUrl: scratch.url, dirs, log: () => {} });
  }

  async function names(table: 'pgmigrations' | 'pgmigrations_local'): Promise<string[]> {
    const exists = await pool.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [table]);
    if (!exists.rows[0]!.ok) return [];
    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM ${table} ORDER BY run_on, id`);
    return rows.map(r => r.name);
  }

  async function snapshot(): Promise<unknown> {
    return {
      upstream: await names('pgmigrations'),
      local: await names('pgmigrations_local'),
    };
  }

  /** A fork before the split: its migrations interleaved with upstream's, in one directory. */
  async function applyForkHistory(): Promise<void> {
    fill(dirs.upstream, ['001_core', '002_core', '003_fork_a', '004_fork_b']);
    await migrate();
    expect(await names('pgmigrations')).toEqual(['001_core', '002_core', '003_fork_a', '004_fork_b']);
  }

  beforeEach(async () => {
    scratch = await createScratchDatabase(DATABASE_URL!, 'tracks', { migrations: 0 });
    pool = new pg.Pool({ connectionString: scratch.url });
    root = mkdtempSync(path.join(tmpdir(), 'curia-tracks-'));
    dirs = { upstream: path.join(root, 'migrations'), local: path.join(root, 'migrations-local') };
  }, 60_000);

  afterEach(async () => {
    await pool?.end();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('runs upstream alone, as before, when the local directory is missing or holds no migrations', async () => {
    fill(dirs.upstream, ['001_core', '002_core']);
    expect(await migrate()).toEqual({ upstream: ['001_core', '002_core'], local: [], moved: [] });
    fill(dirs.local, []);
    expect(await migrate()).toEqual({ upstream: [], local: [], moved: [] });
    expect(await names('pgmigrations_local')).toEqual([]);
    const { rows } = await pool.query("SELECT to_regclass('pgmigrations_local') AS t");
    expect(rows[0].t).toBeNull();
  });

  it('moves a fork\'s applied migrations, applies new upstream ones, and is a no-op the second time', async () => {
    await applyForkHistory();
    const before = await pool.query<{ id: number; name: string; run_on: Date }>(
      "SELECT id, name, run_on FROM pgmigrations WHERE name LIKE '%fork%' ORDER BY id",
    );

    fill(dirs.upstream, ['001_core', '002_core', '003_core_new']);
    fill(dirs.local, ['003_fork_a', '004_fork_b']);
    expect(await migrate()).toEqual({ upstream: ['003_core_new'], local: [], moved: ['003_fork_a', '004_fork_b'] });
    expect(await snapshot()).toEqual({ upstream: ['001_core', '002_core', '003_core_new'], local: ['003_fork_a', '004_fork_b'] });

    // id, name and run_on survive the move.
    const after = await pool.query('SELECT id, name, run_on FROM pgmigrations_local ORDER BY id');
    expect(after.rows).toEqual(before.rows);

    expect(await migrate()).toEqual({ upstream: [], local: [], moved: [] });

    // A new local migration takes an id past the moved rows.
    fill(dirs.local, ['003_fork_a', '004_fork_b', '005_fork_c']);
    expect(await migrate()).toEqual({ upstream: [], local: ['005_fork_c'], moved: [] });

    // An upstream migration added after local ones have run applies cleanly.
    fill(dirs.upstream, ['001_core', '002_core', '003_core_new', '004_core_later']);
    expect(await migrate()).toEqual({ upstream: ['004_core_later'], local: [], moved: [] });
    expect(await snapshot()).toEqual({
      upstream: ['001_core', '002_core', '003_core_new', '004_core_later'],
      local: ['003_fork_a', '004_fork_b', '005_fork_c'],
    });
  });

  it('still catches an out-of-order migration within each track', async () => {
    fill(dirs.upstream, ['001_core', '002_core']);
    fill(dirs.local, ['003_fork_a']);
    await migrate();

    fill(dirs.local, ['001_fork_early', '003_fork_a']);
    await expect(migrate()).rejects.toThrow('Not run migration 001_fork_early is preceding already run migration 003_fork_a');

    fill(dirs.local, ['003_fork_a']);
    fill(dirs.upstream, ['000_core_early', '001_core', '002_core']);
    await expect(migrate()).rejects.toThrow('Not run migration 000_core_early is preceding already run migration 001_core');

    // With no local track at all, node-pg-migrate's own check still applies upstream.
    rmSync(dirs.local, { recursive: true });
    await expect(migrate()).rejects.toThrow('Not run migration 000_core_early is preceding already run migration 001_core');
  });

  describe('refuses, writing nothing', () => {
    async function expectRefusal(message: string): Promise<void> {
      const before = await snapshot();
      const err = await migrate().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationReconciliationError);
      expect((err as Error).message).toContain(message);
      expect(await snapshot()).toEqual(before);
      const { rows } = await pool.query("SELECT to_regclass('pgmigrations_local') AS t");
      expect(rows[0].t).toBeNull();
    }

    it('when a name is in both directories', async () => {
      await applyForkHistory();
      fill(dirs.local, ['003_fork_a', '004_fork_b']);
      await expectRefusal('003_fork_a is in both the upstream and the local migration directory');
    });

    it('when a history row has no file', async () => {
      await applyForkHistory();
      fill(dirs.upstream, ['001_core', '002_core']);
      fill(dirs.local, ['003_fork_a']);
      await expectRefusal('pgmigrations records 004_fork_b, which matches no file in either migration directory');
    });

    it('when the local track was applied out of filename order', async () => {
      await applyForkHistory();
      // The fork renumbered: 004_fork_b is now 002_fork_b, but it ran after 003_fork_a.
      fill(dirs.upstream, ['001_core', '002_core']);
      fill(dirs.local, ['003_fork_a']);
      writeFileSync(path.join(dirs.local, '002_fork_b.sql'), SQL['004_fork_b']!);
      await pool.query("UPDATE pgmigrations SET name = '002_fork_b' WHERE name = '004_fork_b'");
      await expectRefusal('Not run migration 002_fork_b is preceding already run migration 003_fork_a');
    });
  });

  it('dry run reports moves, order checks and objects on both tracks without writing', async () => {
    await applyForkHistory();
    fill(dirs.upstream, ['001_core', '002_core', '003_core_new']);
    fill(dirs.local, ['003_fork_a', '004_fork_b']);
    // Upstream now ships fork_a's table as well, under its own name.
    writeFileSync(path.join(dirs.upstream, '003_core_new.sql'), 'CREATE TABLE IF NOT EXISTS fork_a (id int PRIMARY KEY);');

    const before = await snapshot();
    const report = await dryRunReconciliation(scratch.url, dirs);
    expect(await snapshot()).toEqual(before);
    const { rows } = await pool.query("SELECT to_regclass('pgmigrations_local') AS t");
    expect(rows[0].t).toBeNull();

    expect(report.plan.moves.map(r => r.name)).toEqual(['003_fork_a', '004_fork_b']);
    expect(report.plan.orderCheck).toEqual({ upstream: { ok: true }, local: { ok: true } });
    expect(report.plan.refusals).toEqual([]);
    expect(report.localObjects).toEqual([
      { file: '003_fork_a', objects: [{ kind: 'table', name: 'fork_a' }] },
      { file: '004_fork_b', objects: [{ kind: 'column', name: 'core_a.fork_note' }] },
    ]);
    expect(report.overlaps).toEqual([
      { object: { kind: 'table', name: 'fork_a' }, upstreamFiles: ['003_core_new'], localFiles: ['003_fork_a'] },
    ]);
  });

  it('dry run proposes renames that let an out-of-order local track pass', async () => {
    await applyForkHistory();
    fill(dirs.upstream, ['001_core', '002_core']);
    fill(dirs.local, ['003_fork_a']);
    writeFileSync(path.join(dirs.local, '002_fork_b.sql'), SQL['004_fork_b']!);
    await pool.query("UPDATE pgmigrations SET name = '002_fork_b' WHERE name = '004_fork_b'");

    const report = await dryRunReconciliation(scratch.url, dirs);
    expect(report.plan.proposedRenames).toEqual([
      { from: '003_fork_a', to: '001_fork_a' },
      { from: '002_fork_b', to: '002_fork_b' },
    ].filter(r => r.from !== r.to));

    // Applying the proposal: rename the file and the row together, then boot reconciles.
    renameSync(path.join(dirs.local, '003_fork_a.sql'), path.join(dirs.local, '001_fork_a.sql'));
    await pool.query("UPDATE pgmigrations SET name = '001_fork_a' WHERE name = '003_fork_a'");
    expect(await migrate()).toEqual({ upstream: [], local: [], moved: ['001_fork_a', '002_fork_b'] });
  });
});
