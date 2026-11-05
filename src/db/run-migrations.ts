// Two migration tracks: upstream and local (#2465, ADR-061).
//
// Upstream migrations live in src/db/migrations/ and are recorded in `pgmigrations`. A
// fork's own migrations live in src/db/migrations-local/ (or CURIA_LOCAL_MIGRATIONS_DIR)
// and are recorded in `pgmigrations_local`. Upstream always runs first, and node-pg-migrate's
// order check stays on within each track, so a fork pulling new upstream migrations never
// finds them sorted behind migrations it has already applied.
//
// Every place that migrates (boot, `pnpm migrate`, install.sh, CI, the test helpers) goes
// through runMigrations() so the tracks and the reconciliation below can't drift apart.
//
// With no local directory, or none of its files a migration, this is exactly one
// node-pg-migrate run over src/db/migrations/, as before.
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import pg from 'pg';
import { runner, PG_MIGRATE_LOCK_ID } from 'node-pg-migrate';
import { getMigrationFilePaths } from 'node-pg-migrate/migration';
import { extractCreatedObjects, type SchemaObject } from './migration-sql.js';

export const UPSTREAM_MIGRATIONS_TABLE = 'pgmigrations';
export const LOCAL_MIGRATIONS_TABLE = 'pgmigrations_local';
export const LOCAL_MIGRATIONS_DIR_ENV = 'CURIA_LOCAL_MIGRATIONS_DIR';

// The local directory ships with a README; dotfiles and Markdown are never migrations.
// node-pg-migrate anchors this as ^…$ and it replaces its default, which skips dotfiles.
const LOCAL_IGNORE_PATTERN = String.raw`(?:\..*|.*\.md)`;

export type MigrationTrack = 'upstream' | 'local';

export interface MigrationDirs {
  upstream: string;
  local: string;
}

export interface MigrationFile {
  /** node-pg-migrate's name for it: the filename without its extension. */
  name: string;
  path: string;
}

/** One row of a history table, in the order node-pg-migrate reads it (run_on, id). */
export interface HistoryRow {
  id: number;
  name: string;
  /** run_on in microseconds since the epoch, exact, so two tables' rows can be merged in order. */
  runOnMicros: bigint;
}

export type OrderCheck = { ok: true } | { ok: false; message: string };

export interface ReconciliationPlan {
  /** pgmigrations rows that belong to the local track, to move to pgmigrations_local. */
  moves: HistoryRow[];
  /** Why the move can't go ahead. Empty when it can. */
  refusals: string[];
  /** node-pg-migrate's order check on each track as it will stand after the moves. */
  orderCheck: Record<MigrationTrack, OrderCheck>;
  /**
   * When the local track would fail its order check: file and history renames that make
   * the filename order match the order the migrations were applied. Empty otherwise.
   */
  proposedRenames: Array<{ from: string; to: string }>;
}

export interface ObjectOverlap {
  object: SchemaObject;
  upstreamFiles: string[];
  localFiles: string[];
}

export interface DryRunReport {
  dirs: MigrationDirs;
  upstreamFiles: string[];
  localFiles: MigrationFile[];
  /** Names already recorded in pgmigrations_local. */
  localHistory: string[];
  plan: ReconciliationPlan;
  /** What each local migration creates. */
  localObjects: Array<{ file: string; objects: SchemaObject[] }>;
  /** Count of distinct objects the upstream migrations create, for scale. */
  upstreamObjectCount: number;
  /** Objects created on both tracks: a fork may have reimplemented an upstream migration. */
  overlaps: ObjectOverlap[];
}

export interface RunMigrationsOptions {
  databaseUrl: string;
  dirs: MigrationDirs;
  /** node-pg-migrate's progress lines. */
  log: (message: string) => void;
  /**
   * Apply at most this many upstream migrations, oldest first, for a test of one migration.
   * The local track is left alone: local migrations may depend on any upstream table.
   */
  count?: number;
}

export interface RunMigrationsResult {
  /** Names applied on each track, in order. */
  upstream: string[];
  local: string[];
  /** Names moved from pgmigrations to pgmigrations_local by reconciliation. */
  moved: string[];
}

/** A refusal to reconcile, carrying every reason found. Nothing was written. */
export class MigrationReconciliationError extends Error {
  constructor(readonly refusals: string[]) {
    super(
      'Refusing to move fork migrations to the local track:\n'
      + refusals.map(r => `  - ${r}`).join('\n')
      + '\nNothing was changed. Run `pnpm migrate --dry-run` for the full plan; see docs/dev/fork-migrations.md.',
    );
    this.name = 'MigrationReconciliationError';
  }
}

/**
 * The two directories for a project root (the directory holding `src/`). The local one is
 * CURIA_LOCAL_MIGRATIONS_DIR when set, resolved against the project root if relative.
 */
export function resolveMigrationDirs(projectRoot: string, env: NodeJS.ProcessEnv = process.env): MigrationDirs {
  const override = env[LOCAL_MIGRATIONS_DIR_ENV]?.trim();
  return {
    upstream: path.join(projectRoot, 'src', 'db', 'migrations'),
    local: override ? path.resolve(projectRoot, override) : path.join(projectRoot, 'src', 'db', 'migrations-local'),
  };
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * A track's migration files in node-pg-migrate's own order. A missing local directory is
 * an empty track; a missing upstream directory is an error, as it always was.
 */
export async function listMigrationFiles(dir: string, track: MigrationTrack): Promise<MigrationFile[]> {
  if (track === 'local' && !(await isDirectory(dir))) return [];
  const paths = await getMigrationFilePaths(dir, {
    ignorePattern: track === 'local' ? LOCAL_IGNORE_PATTERN : undefined,
  });
  return paths.map(p => ({ name: path.basename(p, path.extname(p)), path: p }));
}

/** node-pg-migrate's checkOrder, returning its message instead of throwing. */
export function checkTrackOrder(appliedInRunOrder: string[], filesInOrder: string[]): OrderCheck {
  const len = Math.min(appliedInRunOrder.length, filesInOrder.length);
  for (let i = 0; i < len; i += 1) {
    if (appliedInRunOrder[i] !== filesInOrder[i]) {
      return {
        ok: false,
        message: `Not run migration ${filesInOrder[i]} is preceding already run migration ${appliedInRunOrder[i]}`,
      };
    }
  }
  return { ok: true };
}

function byRunOrder(a: HistoryRow, b: HistoryRow): number {
  if (a.runOnMicros !== b.runOnMicros) return a.runOnMicros < b.runOnMicros ? -1 : 1;
  return a.id - b.id;
}

/**
 * Renames that put the local files in the order they were applied, then the unapplied ones
 * in their current order. Keeps each name's descriptive part and renumbers from 1.
 */
function proposeLocalRenames(appliedInRunOrder: string[], localFiles: string[]): Array<{ from: string; to: string }> {
  const applied = new Set(appliedInRunOrder);
  const ordered = [...appliedInRunOrder, ...localFiles.filter(name => !applied.has(name))];
  const width = Math.max(3, String(ordered.length).length);
  return ordered
    .map((from, i) => {
      const rest = from.replace(/^\d+_?/, '') || from;
      return { from, to: `${String(i + 1).padStart(width, '0')}_${rest}` };
    })
    .filter(({ from, to }) => from !== to);
}

/**
 * Decides what reconciliation would do, without touching the database. Rows of
 * pgmigrations whose name is a local file move to pgmigrations_local, keeping id, name and
 * run_on. It refuses rather than guesses when a name is in both directories, a history row
 * has no file, a name is already recorded on both tracks, or either track would then fail
 * node-pg-migrate's order check.
 */
export function planReconciliation(input: {
  upstreamFiles: string[];
  localFiles: string[];
  upstreamHistory: HistoryRow[];
  localHistory: HistoryRow[];
}): ReconciliationPlan {
  const { upstreamFiles, localFiles, upstreamHistory, localHistory } = input;
  const upstreamSet = new Set(upstreamFiles);
  const localSet = new Set(localFiles);
  const refusals: string[] = [];

  const inBoth = localFiles.filter(name => upstreamSet.has(name));
  for (const name of inBoth) {
    refusals.push(`${name} is in both the upstream and the local migration directory. A migration belongs to one track: remove one copy.`);
  }
  if (inBoth.length > 0) {
    return { moves: [], refusals, orderCheck: { upstream: { ok: true }, local: { ok: true } }, proposedRenames: [] };
  }

  const moves = upstreamHistory.filter(row => localSet.has(row.name));
  const localNames = new Set(localHistory.map(row => row.name));
  const localIds = new Set(localHistory.map(row => row.id));
  for (const row of moves) {
    if (localNames.has(row.name)) {
      refusals.push(`${row.name} is recorded in both ${UPSTREAM_MIGRATIONS_TABLE} and ${LOCAL_MIGRATIONS_TABLE}. Delete the row that is wrong by hand.`);
    } else if (localIds.has(row.id)) {
      refusals.push(`${row.name} (${UPSTREAM_MIGRATIONS_TABLE} id ${row.id}) can't keep its id: ${LOCAL_MIGRATIONS_TABLE} already has a row with id ${row.id}.`);
    }
  }

  const remainingUpstream = upstreamHistory.filter(row => !localSet.has(row.name));
  for (const row of remainingUpstream) {
    if (!upstreamSet.has(row.name)) {
      refusals.push(`${UPSTREAM_MIGRATIONS_TABLE} records ${row.name}, which matches no file in either migration directory. Restore the file, or move it into the local directory if it is the fork's.`);
    }
  }
  for (const row of localHistory) {
    if (!localSet.has(row.name)) {
      refusals.push(`${LOCAL_MIGRATIONS_TABLE} records ${row.name}, which matches no file in the local migration directory. Restore the file.`);
    }
  }

  // Rows with no file are refused above; leaving them out keeps the order check about order.
  const mergedLocal = [...localHistory, ...moves].toSorted(byRunOrder).map(row => row.name).filter(name => localSet.has(name));
  const orderCheck: Record<MigrationTrack, OrderCheck> = {
    upstream: checkTrackOrder(remainingUpstream.map(row => row.name).filter(name => upstreamSet.has(name)), upstreamFiles),
    local: checkTrackOrder(mergedLocal, localFiles),
  };
  if (!orderCheck.upstream.ok) {
    refusals.push(`The upstream track would fail its order check: ${orderCheck.upstream.message}.`);
  }
  let proposedRenames: Array<{ from: string; to: string }> = [];
  if (!orderCheck.local.ok) {
    proposedRenames = proposeLocalRenames(mergedLocal, localFiles);
    refusals.push(
      `The local track would fail its order check: ${orderCheck.local.message}. Its migrations were applied in a different order from their filenames; `
      + 'rename the files and their history rows together (the dry run proposes the renames).',
    );
  }

  return { moves, refusals, orderCheck, proposedRenames };
}

type Queryable = Pick<pg.ClientBase, 'query'>;

async function tableExists(db: Queryable, table: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${table}`]);
  return rows[0]!.exists;
}

async function readHistory(db: Queryable, table: typeof UPSTREAM_MIGRATIONS_TABLE | typeof LOCAL_MIGRATIONS_TABLE): Promise<HistoryRow[]> {
  if (!(await tableExists(db, table))) return [];
  // The table name is one of two constants, never input.
  const { rows } = await db.query<{ id: number; name: string; run_on_us: string }>(
    `SELECT id, name, (extract(epoch FROM run_on) * 1000000)::bigint::text AS run_on_us
       FROM public.${table} ORDER BY run_on, id`,
  );
  return rows.map(row => ({ id: row.id, name: row.name, runOnMicros: BigInt(row.run_on_us) }));
}

/**
 * Moves applied fork migrations from pgmigrations to pgmigrations_local, in one transaction
 * under node-pg-migrate's advisory lock. Throws MigrationReconciliationError, writing
 * nothing, when the plan refuses. A second run finds nothing to move.
 */
async function reconcile(databaseUrl: string, upstreamFiles: string[], localFiles: string[]): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      const { rows: [lock] } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
        [String(PG_MIGRATE_LOCK_ID)],
      );
      if (!lock!.locked) throw new Error('Another migration is already running.');
      // The same shape node-pg-migrate creates, so its own check accepts the table.
      await client.query(
        `CREATE TABLE IF NOT EXISTS public.${LOCAL_MIGRATIONS_TABLE} (id SERIAL PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL)`,
      );
      const plan = planReconciliation({
        upstreamFiles,
        localFiles,
        upstreamHistory: await readHistory(client, UPSTREAM_MIGRATIONS_TABLE),
        localHistory: await readHistory(client, LOCAL_MIGRATIONS_TABLE),
      });
      if (plan.refusals.length > 0) throw new MigrationReconciliationError(plan.refusals);

      const moved = plan.moves.map(row => row.name);
      if (moved.length > 0) {
        await client.query(
          `INSERT INTO public.${LOCAL_MIGRATIONS_TABLE} (id, name, run_on)
             SELECT id, name, run_on FROM public.${UPSTREAM_MIGRATIONS_TABLE} WHERE name = ANY($1::text[])`,
          [moved],
        );
        await client.query(`DELETE FROM public.${UPSTREAM_MIGRATIONS_TABLE} WHERE name = ANY($1::text[])`, [moved]);
        // Rows came in with their own ids, so move the sequence past them.
        await client.query(
          `SELECT setval(pg_get_serial_sequence('public.${LOCAL_MIGRATIONS_TABLE}', 'id'), (SELECT max(id) FROM public.${LOCAL_MIGRATIONS_TABLE}))`,
        );
      }
      await client.query('COMMIT');
      return moved;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
}

/**
 * Applies pending migrations: reconciliation, then upstream into pgmigrations, then local
 * into pgmigrations_local. Reconciliation and the local run happen only when the local
 * directory holds at least one migration.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const { databaseUrl, dirs, log, count } = options;
  const upstreamFiles = await listMigrationFiles(dirs.upstream, 'upstream');
  const localFiles = await listMigrationFiles(dirs.local, 'local');
  const useLocal = localFiles.length > 0 && count === undefined;

  const moved = useLocal
    ? await reconcile(databaseUrl, upstreamFiles.map(f => f.name), localFiles.map(f => f.name))
    : [];

  const upstream = await runner({
    databaseUrl,
    dir: dirs.upstream,
    migrationsTable: UPSTREAM_MIGRATIONS_TABLE,
    direction: 'up',
    count,
    log,
  });
  const local = useLocal
    ? await runner({
      databaseUrl,
      dir: dirs.local,
      ignorePattern: LOCAL_IGNORE_PATTERN,
      migrationsTable: LOCAL_MIGRATIONS_TABLE,
      direction: 'up',
      log,
    })
    : [];

  return { upstream: upstream.map(m => m.name), local: local.map(m => m.name), moved };
}

async function createdObjects(files: MigrationFile[]): Promise<Array<{ file: string; objects: SchemaObject[] }>> {
  return Promise.all(files.map(async f => ({ file: f.name, objects: extractCreatedObjects(await readFile(f.path, 'utf8')) })));
}

function objectKey(o: SchemaObject): string {
  return `${o.kind}:${o.name}`;
}

/**
 * What reconciliation would do on this database, without writing: the moves, the order
 * check on each track, any refusals and proposed renames, and the schema objects both
 * tracks create (an overlap a name match can't see).
 */
export async function dryRunReconciliation(databaseUrl: string, dirs: MigrationDirs): Promise<DryRunReport> {
  const upstreamFiles = await listMigrationFiles(dirs.upstream, 'upstream');
  const localFiles = await listMigrationFiles(dirs.local, 'local');

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let plan: ReconciliationPlan;
  let localHistory: HistoryRow[];
  try {
    localHistory = await readHistory(client, LOCAL_MIGRATIONS_TABLE);
    plan = planReconciliation({
      upstreamFiles: upstreamFiles.map(f => f.name),
      localFiles: localFiles.map(f => f.name),
      upstreamHistory: await readHistory(client, UPSTREAM_MIGRATIONS_TABLE),
      localHistory,
    });
  } finally {
    await client.end();
  }

  const upstreamObjects = await createdObjects(upstreamFiles);
  const localObjects = await createdObjects(localFiles);
  const upstreamByKey = new Map<string, { object: SchemaObject; files: string[] }>();
  for (const { file, objects } of upstreamObjects) {
    for (const object of objects) {
      const entry = upstreamByKey.get(objectKey(object)) ?? { object, files: [] };
      entry.files.push(file);
      upstreamByKey.set(objectKey(object), entry);
    }
  }
  const overlapsByKey = new Map<string, ObjectOverlap>();
  for (const { file, objects } of localObjects) {
    for (const object of objects) {
      const upstreamEntry = upstreamByKey.get(objectKey(object));
      if (!upstreamEntry) continue;
      const overlap = overlapsByKey.get(objectKey(object)) ?? { object, upstreamFiles: upstreamEntry.files, localFiles: [] };
      overlap.localFiles.push(file);
      overlapsByKey.set(objectKey(object), overlap);
    }
  }

  return {
    dirs,
    upstreamFiles: upstreamFiles.map(f => f.name),
    localFiles,
    localHistory: localHistory.map(row => row.name),
    plan,
    localObjects,
    upstreamObjectCount: upstreamByKey.size,
    overlaps: [...overlapsByKey.values()],
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function describeObject(o: SchemaObject): string {
  return `${o.kind} ${o.name}`;
}

/** The dry run as text for an operator. */
export function formatDryRunReport(report: DryRunReport): string {
  const { plan } = report;
  const lines: string[] = [
    'Migration reconciliation dry run — nothing has been written.',
    '',
    `Upstream directory: ${report.dirs.upstream} (${report.upstreamFiles.length} migrations)`,
    `Local directory:    ${report.dirs.local} (${report.localFiles.length} migrations)`,
    '',
  ];
  if (report.localFiles.length === 0) {
    lines.push('No local migrations: boot runs the upstream track alone, exactly as before. Nothing to reconcile.');
    return lines.join('\n');
  }

  lines.push(`Planned moves from ${UPSTREAM_MIGRATIONS_TABLE} to ${LOCAL_MIGRATIONS_TABLE} (${plan.moves.length}):`);
  if (plan.moves.length === 0) lines.push('  (none)');
  for (const row of plan.moves) lines.push(`  - ${row.name} (id ${row.id})`);
  lines.push('', 'Order check after the moves:');
  for (const track of ['upstream', 'local'] as const) {
    const check = plan.orderCheck[track];
    lines.push(`  ${track}: ${check.ok ? 'ok' : `FAILS — ${check.message}`}`);
  }

  if (plan.proposedRenames.length > 0) {
    lines.push('', 'Proposed renames for the local track (apply the files and the rows together):');
    // Two steps each, so a new name that equals another file's or row's old name never
    // collides partway through.
    const filePath = new Map(report.localFiles.map(f => [f.name, f.path]));
    for (const { from } of plan.proposedRenames) {
      const current = filePath.get(from)!;
      lines.push(`  git mv ${current} ${current}.renaming`);
    }
    for (const { from, to } of plan.proposedRenames) {
      const current = filePath.get(from)!;
      lines.push(`  git mv ${current}.renaming ${path.join(path.dirname(current), to + path.extname(current))}`);
    }
    // A row not moved yet is still in pgmigrations; the next boot moves it under its new name.
    // Migrations not yet applied have no row, so only their files are renamed.
    const notMoved = new Set(plan.moves.map(row => row.name));
    const applied = new Set([...plan.moves.map(row => row.name), ...report.localHistory]);
    const rowRenames = plan.proposedRenames
      .filter(({ from }) => applied.has(from))
      .map(r => ({ ...r, table: notMoved.has(r.from) ? UPSTREAM_MIGRATIONS_TABLE : LOCAL_MIGRATIONS_TABLE }));
    if (rowRenames.length > 0) {
      lines.push('  BEGIN;');
      for (const { from, table } of rowRenames) {
        lines.push(`  UPDATE ${table} SET name = 'renaming:' || name WHERE name = ${sqlLiteral(from)};`);
      }
      for (const { from, to, table } of rowRenames) {
        lines.push(`  UPDATE ${table} SET name = ${sqlLiteral(to)} WHERE name = ${sqlLiteral(`renaming:${from}`)};`);
      }
      lines.push('  COMMIT;');
    }
  }

  lines.push('', 'Objects the local migrations create:');
  for (const { file, objects } of report.localObjects) {
    lines.push(`  ${file}: ${objects.length > 0 ? objects.map(describeObject).join(', ') : '(none found)'}`);
  }
  lines.push(`  (The upstream migrations create ${report.upstreamObjectCount} distinct tables, columns and indexes.)`);

  lines.push('', 'Objects created on both tracks:');
  if (report.overlaps.length === 0) lines.push('  (none)');
  for (const overlap of report.overlaps) {
    lines.push(`  WARNING ${describeObject(overlap.object)}: upstream ${overlap.upstreamFiles.join(', ')}; local ${overlap.localFiles.join(', ')}`);
  }
  if (report.overlaps.length > 0) {
    lines.push('  An upstream migration that recreates one of these may fail, or skip it, on this database. Check each by hand.');
  }

  lines.push('');
  if (plan.refusals.length > 0) {
    lines.push('Boot would REFUSE to reconcile:');
    for (const refusal of plan.refusals) lines.push(`  - ${refusal}`);
  } else {
    lines.push('Boot would reconcile cleanly.');
  }
  return lines.join('\n');
}
