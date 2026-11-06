import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkTrackOrder,
  dryRunExitCode,
  formatDryRunReport,
  listMigrationFiles,
  planReconciliation,
  resolveMigrationDirs,
  shellQuote,
  type DryRunReport,
  type HistoryRow,
} from '../../../src/db/run-migrations.js';

/** History rows applied one second apart, in the order given. */
function history(names: string[], firstId = 1): HistoryRow[] {
  return names.map((name, i) => ({ id: firstId + i, name, runOnMicros: BigInt(i + firstId) * 1_000_000n }));
}

describe('resolveMigrationDirs', () => {
  it('defaults to src/db/migrations and src/db/migrations-local under the project root', () => {
    expect(resolveMigrationDirs('/app', {})).toEqual({
      upstream: '/app/src/db/migrations',
      local: '/app/src/db/migrations-local',
      localRequired: false,
    });
  });

  it('takes the local directory from CURIA_LOCAL_MIGRATIONS_DIR, relative to the root', () => {
    expect(resolveMigrationDirs('/app', { CURIA_LOCAL_MIGRATIONS_DIR: 'deploy/migrations' })).toMatchObject({
      local: '/app/deploy/migrations',
      localRequired: true,
    });
    expect(resolveMigrationDirs('/app', { CURIA_LOCAL_MIGRATIONS_DIR: '/srv/m' }).local).toBe('/srv/m');
    expect(resolveMigrationDirs('/app', { CURIA_LOCAL_MIGRATIONS_DIR: '  ' }).local).toBe('/app/src/db/migrations-local');
  });
});

describe('listMigrationFiles', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'curia-migrations-'));
    mkdirSync(path.join(dir, 'local'));
    for (const name of ['10_ten.sql', '9_nine.sql', '011_eleven.js', 'README.md', '.gitkeep']) {
      writeFileSync(path.join(dir, 'local', name), '');
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lists the local track in numeric order, skipping Markdown and dotfiles', async () => {
    const files = await listMigrationFiles(path.join(dir, 'local'), 'local');
    expect(files.map(f => f.name)).toEqual(['9_nine', '10_ten', '011_eleven']);
  });

  it('treats a missing local directory as an empty track', async () => {
    expect(await listMigrationFiles(path.join(dir, 'absent'), 'local')).toEqual([]);
  });

  it('fails on a missing local directory that was named explicitly', async () => {
    await expect(listMigrationFiles(path.join(dir, 'absent'), 'local', { required: true }))
      .rejects.toThrow(/CURIA_LOCAL_MIGRATIONS_DIR names .*absent, which does not exist/);
  });

  it('fails on a local path that is a file', async () => {
    await expect(listMigrationFiles(path.join(dir, 'local', 'README.md'), 'local'))
      .rejects.toThrow(/is not a directory/);
  });

  it('still fails on a missing upstream directory', async () => {
    await expect(listMigrationFiles(path.join(dir, 'absent'), 'upstream')).rejects.toThrow();
  });
});

describe('checkTrackOrder', () => {
  it("matches node-pg-migrate's check and message", () => {
    expect(checkTrackOrder(['001_a', '002_b'], ['001_a', '002_b', '003_c'])).toEqual({ status: 'ok' });
    expect(checkTrackOrder(['001_a', '003_c'], ['001_a', '002_b', '003_c'])).toEqual({
      status: 'failed',
      message: 'Not run migration 002_b is preceding already run migration 003_c',
    });
  });
});

describe('planReconciliation', () => {
  const upstreamFiles = ['001_core', '002_core', '003_upstream_new'];

  it('moves applied fork migrations and leaves both tracks in order', () => {
    const plan = planReconciliation({
      upstreamFiles,
      localFiles: ['003_fork_a', '004_fork_b'],
      upstreamHistory: history(['001_core', '002_core', '003_fork_a', '004_fork_b']),
      localHistory: [],
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.moves.map(r => r.name)).toEqual(['003_fork_a', '004_fork_b']);
    expect(plan.orderCheck).toEqual({ upstream: { status: 'ok' }, local: { status: 'ok' } });
  });

  it('has nothing to move once moved', () => {
    const plan = planReconciliation({
      upstreamFiles,
      localFiles: ['003_fork_a', '004_fork_b'],
      upstreamHistory: history(['001_core', '002_core', '003_upstream_new']),
      localHistory: history(['003_fork_a', '004_fork_b'], 10),
    });
    expect(plan.moves).toEqual([]);
    expect(plan.refusals).toEqual([]);
  });

  it('refuses a name in both directories', () => {
    const plan = planReconciliation({
      upstreamFiles,
      localFiles: ['002_core'],
      upstreamHistory: history(['001_core', '002_core']),
      localHistory: [],
    });
    expect(plan.moves).toEqual([]);
    expect(plan.refusals).toEqual([expect.stringContaining('002_core is in both')]);
    expect(plan.orderCheck).toEqual({ upstream: { status: 'not-run' }, local: { status: 'not-run' } });
  });

  it('refuses a history row with no file on either track', () => {
    const plan = planReconciliation({
      upstreamFiles,
      localFiles: ['003_fork_a'],
      upstreamHistory: history(['001_core', '002_core', '003_fork_a', '004_deleted']),
      localHistory: history(['005_gone'], 20),
    });
    expect(plan.refusals).toEqual([
      expect.stringContaining('pgmigrations records 004_deleted'),
      expect.stringContaining('pgmigrations_local records 005_gone'),
    ]);
  });

  it('refuses a name already recorded on both tracks, or an id it cannot keep', () => {
    const plan = planReconciliation({
      upstreamFiles,
      localFiles: ['003_fork_a', '004_fork_b'],
      upstreamHistory: history(['001_core', '002_core', '003_fork_a', '004_fork_b']),
      localHistory: [{ id: 99, name: '003_fork_a', runOnMicros: 1n }, { id: 4, name: '004_fork_b', runOnMicros: 2n }],
    });
    expect(plan.refusals).toEqual([
      expect.stringContaining('003_fork_a is recorded in both'),
      expect.stringContaining('004_fork_b is recorded in both'),
    ]);
    const idClash = planReconciliation({
      upstreamFiles,
      localFiles: ['003_fork_a', '010_later'],
      upstreamHistory: history(['001_core', '002_core', '003_fork_a']),
      localHistory: [{ id: 3, name: '010_later', runOnMicros: 9_000_000n }],
    });
    expect(idClash.refusals).toEqual([expect.stringContaining("can't keep its id")]);
  });

  it('refuses an out-of-order local track and proposes renames that fix it', () => {
    // 005_fork_b was applied before 004_fork_a (renumbered mid-stream), and 006_fork_c is pending.
    const plan = planReconciliation({
      upstreamFiles,
      localFiles: ['004_fork_a', '005_fork_b', '006_fork_c'],
      upstreamHistory: history(['001_core', '002_core', '005_fork_b', '004_fork_a']),
      localHistory: [],
    });
    expect(plan.orderCheck.local).toEqual({
      status: 'failed',
      message: 'Not run migration 004_fork_a is preceding already run migration 005_fork_b',
    });
    expect(plan.refusals).toEqual([expect.stringContaining('local track would fail its order check')]);
    expect(plan.proposedRenames).toEqual([
      { from: '005_fork_b', to: '001_fork_b' },
      { from: '004_fork_a', to: '002_fork_a' },
      { from: '006_fork_c', to: '003_fork_c' },
    ]);
  });

  it('orders moved rows and existing local rows together by run_on', () => {
    const plan = planReconciliation({
      upstreamFiles,
      localFiles: ['010_fork_x', '020_fork_y'],
      upstreamHistory: [{ id: 3, name: '020_fork_y', runOnMicros: 5n }],
      localHistory: [{ id: 50, name: '010_fork_x', runOnMicros: 9n }],
    });
    expect(plan.orderCheck.local).toEqual({
      status: 'failed',
      message: 'Not run migration 010_fork_x is preceding already run migration 020_fork_y',
    });
  });

  it('refuses an upstream track that would fail its order check', () => {
    const plan = planReconciliation({
      upstreamFiles,
      localFiles: ['050_fork'],
      upstreamHistory: history(['001_core', '003_upstream_new']),
      localHistory: [],
    });
    expect(plan.refusals).toEqual([expect.stringContaining('upstream track would fail its order check')]);
    expect(plan.proposedRenames).toEqual([]);
  });
});

describe('formatDryRunReport', () => {
  const base: DryRunReport = {
    dirs: { upstream: '/app/src/db/migrations', local: "/app/my fork's/migrations-local" },
    upstreamFiles: ['001_core'],
    localFiles: [
      { name: '005_fork_b', path: "/app/my fork's/migrations-local/005_fork_b.sql" },
      { name: '004_fork_a', path: "/app/my fork's/migrations-local/004_fork_a.sql" },
    ],
    localHistory: [],
    historyTables: { upstream: true, local: false },
    localTrackInUse: true,
    plan: {
      moves: history(['005_fork_b', '004_fork_a']),
      refusals: ['The local track would fail its order check: …'],
      orderCheck: { upstream: { status: 'ok' }, local: { status: 'failed', message: 'Not run migration 004_fork_a is preceding already run migration 005_fork_b' } },
      proposedRenames: [{ from: '005_fork_b', to: '001_fork_b' }, { from: '004_fork_a', to: '002_fork_a' }],
    },
    localObjects: [{ file: '004_fork_a', objects: [{ kind: 'column', name: 'scheduled_jobs.name' }] }, { file: '005_fork_b', objects: [] }],
    upstreamObjectCount: 3,
    overlaps: [{ object: { kind: 'column', name: 'scheduled_jobs.name' }, upstreamFiles: ['001_core'], localFiles: ['004_fork_a'] }],
  };

  it('prints moves, order checks, renames, objects, overlaps and the verdict', () => {
    const text = formatDryRunReport(base);
    expect(text).toContain('nothing has been written');
    expect(text).toContain('  - 005_fork_b (id 1)');
    expect(text).toContain('  local: FAILS — Not run migration 004_fork_a');
    // Quoted for the shell: the path holds a space and a single quote.
    expect(text).toContain(String.raw`git mv '/app/my fork'\''s/migrations-local/005_fork_b.sql' '/app/my fork'\''s/migrations-local/005_fork_b.sql.renaming'`);
    expect(text).toContain(String.raw`git mv '/app/my fork'\''s/migrations-local/005_fork_b.sql.renaming' '/app/my fork'\''s/migrations-local/001_fork_b.sql'`);
    // Not moved yet, so the rows are renamed where they are.
    expect(text).toContain("UPDATE pgmigrations SET name = '001_fork_b' WHERE name = 'renaming:005_fork_b';");
    expect(text).toContain('004_fork_a: column scheduled_jobs.name');
    expect(text).toContain('WARNING column scheduled_jobs.name: upstream 001_core; local 004_fork_a');
    expect(text).toContain('Boot would STOP:');
    expect(text).toContain('  - The local track would fail its order check');
  });

  it('marks order checks it did not run', () => {
    const text = formatDryRunReport({
      ...base,
      plan: { ...base.plan, orderCheck: { upstream: { status: 'not-run' }, local: { status: 'not-run' } } },
    });
    expect(text).toContain('  upstream: not run');
    expect(text).toContain('  local: not run');
  });

  it('without a local track, still prints the upstream order check and why boot would stop', () => {
    const noLocal: DryRunReport = {
      ...base,
      localFiles: [],
      localTrackInUse: false,
      localObjects: [],
      overlaps: [],
      plan: {
        moves: [],
        refusals: ["Boot will fail node-pg-migrate's order check: Not run migration 112_web_push is preceding already run migration 112_fork."],
        orderCheck: { upstream: { status: 'failed', message: 'Not run migration 112_web_push is preceding already run migration 112_fork' }, local: { status: 'not-run' } },
        proposedRenames: [],
      },
    };
    const text = formatDryRunReport(noLocal);
    expect(text).toContain('No local migrations and no pgmigrations_local history');
    expect(text).toContain('Order check (upstream, as node-pg-migrate runs it at boot): FAILS — Not run migration 112_web_push');
    expect(text).toContain('Boot would STOP:');
    expect(dryRunExitCode(noLocal)).toBe(1);

    const clean = { ...noLocal, plan: { ...noLocal.plan, refusals: [], orderCheck: { upstream: { status: 'ok' as const }, local: { status: 'not-run' as const } } } };
    expect(formatDryRunReport(clean)).toContain('Boot would go ahead.');
    expect(dryRunExitCode(clean)).toBe(0);
  });

  it('says when the database has never been migrated', () => {
    const text = formatDryRunReport({ ...base, historyTables: { upstream: false, local: false } });
    expect(text).toContain('pgmigrations not found: this database has never been migrated');
  });

  it('says a clean overlap search is not proof, and exits 2 on warnings alone', () => {
    const noRefusals = { ...base, plan: { ...base.plan, refusals: [], proposedRenames: [] } };
    expect(formatDryRunReport({ ...noRefusals, overlaps: [] })).toContain('(none detected — this is a text match over the SQL, not proof)');
    expect(formatDryRunReport(noRefusals)).toContain('Boot would go ahead, but check the warnings above.');
    expect(dryRunExitCode(noRefusals)).toBe(2);
    expect(dryRunExitCode({ ...noRefusals, overlaps: [] })).toBe(0);
    expect(dryRunExitCode(base)).toBe(1);
  });
});

describe('shellQuote', () => {
  it('single-quotes, escaping embedded single quotes', () => {
    expect(shellQuote('/a b/c')).toBe("'/a b/c'");
    expect(shellQuote("it's $(x)")).toBe(String.raw`'it'\''s $(x)'`);
  });
});
