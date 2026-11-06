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
// The local track is in use when the local directory holds a migration or
// `pgmigrations_local` has a row. When it is not, this is exactly one node-pg-migrate run
// over src/db/migrations/, as before: nothing is created, moved or checked beyond that.
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
  /**
   * The local directory was named explicitly (CURIA_LOCAL_MIGRATIONS_DIR), so a missing one
   * is a misconfiguration, not an empty track.
   */
  localRequired?: boolean;
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

export type OrderCheck =
  | { status: 'ok' }
  | { status: 'failed'; message: string }
  /** Not checked, because a refusal makes the result meaningless (a name in both directories). */
  | { status: 'not-run' };

export interface ReconciliationPlan {
  /** pgmigrations rows that belong to the local track, to move to pgmigrations_local. */
  moves: HistoryRow[];
  /** Why boot would stop. Empty when it can go ahead. */
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
  /** Whether each history table exists. No `pgmigrations` means a never-migrated database. */
  historyTables: Record<MigrationTrack, boolean>;
  /** Whether boot would reconcile and run the local track. */
  localTrackInUse: boolean;
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
  /** Whether the local track was reconciled and run. */
  localTrackInUse: boolean;
  localDir: string;
  localFileCount: number;
}

/** Boot can't go ahead on this history; every reason found is listed. Nothing was written. */
export class MigrationReconciliationError extends Error {
  constructor(readonly refusals: string[]) {
    super(
      'Migration history check failed, so no migration ran and nothing was changed:\n'
      + refusals.map(r => `  - ${r}`).join('\n')
      + '\nRun `pnpm migrate --dry-run` for the full plan; see docs/dev/fork-migrations.md.',
    );
    this.name = 'MigrationReconciliationError';
  }
}

/**
 * The two directories for a project root (the directory holding `src/`). The local one is
 * CURIA_LOCAL_MIGRATIONS_DIR when set, resolved against the project root if relative, and
 * then must exist.
 */
export function resolveMigrationDirs(projectRoot: string, env: NodeJS.ProcessEnv = process.env): MigrationDirs {
  const override = env[LOCAL_MIGRATIONS_DIR_ENV]?.trim();
  return {
    upstream: path.join(projectRoot, 'src', 'db', 'migrations'),
    local: override ? path.resolve(projectRoot, override) : path.join(projectRoot, 'src', 'db', 'migrations-local'),
    localRequired: Boolean(override),
  };
}

async function pathKind(target: string): Promise<'missing' | 'directory' | 'other'> {
  try {
    return (await stat(target)).isDirectory() ? 'directory' : 'other';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw err;
  }
}

/**
 * A track's migration files in node-pg-migrate's own order. The default local directory may
 * be missing (an empty track); an explicitly named one may not. A local path that exists but
 * is not a directory is always an error, as is a missing upstream directory.
 */
export async function listMigrationFiles(
  dir: string,
  track: MigrationTrack,
  options: { required?: boolean } = {},
): Promise<MigrationFile[]> {
  if (track === 'local') {
    const kind = await pathKind(dir);
    if (kind === 'other') throw new Error(`The local migration directory ${dir} is not a directory.`);
    if (kind === 'missing') {
      if (options.required) {
        throw new Error(
          `${LOCAL_MIGRATIONS_DIR_ENV} names ${dir}, which does not exist. Fix the path, or unset it to use src/db/migrations-local.`,
        );
      }
      return [];
    }
  }
  const paths = await getMigrationFilePaths(dir, {
    ignorePattern: track === 'local' ? LOCAL_IGNORE_PATTERN : undefined,
  });
  return paths.map(p => ({ name: path.basename(p, path.extname(p)), path: p }));
}

function listLocalFiles(dirs: MigrationDirs): Promise<MigrationFile[]> {
  return listMigrationFiles(dirs.local, 'local', { required: dirs.localRequired });
}

/** node-pg-migrate's checkOrder, returning its message instead of throwing. */
export function checkTrackOrder(appliedInRunOrder: string[], filesInOrder: string[]): OrderCheck {
  const len = Math.min(appliedInRunOrder.length, filesInOrder.length);
  for (let i = 0; i < len; i += 1) {
    if (appliedInRunOrder[i] !== filesInOrder[i]) {
      return {
        status: 'failed',
        message: `Not run migration ${filesInOrder[i]} is preceding already run migration ${appliedInRunOrder[i]}`,
      };
    }
  }
  return { status: 'ok' };
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
    return { moves: [], refusals, orderCheck: { upstream: { status: 'not-run' }, local: { status: 'not-run' } }, proposedRenames: [] };
  }

  const moves = upstreamHistory.filter(row => localSet.has(row.name));
  const localNames = new Set(localHistory.map(row => row.name));
  const localIds = new Set(localHistory.map(row => row.id));
  for (const row of moves) {
    if (localNames.has(row.name)) {
      refusals.push(`${row.name} is recorded in both ${UPSTREAM_MIGRATIONS_TABLE} and ${LOCAL_MIGRATIONS_TABLE}. Delete the row that is wrong by hand.`);
    } else if (localIds.has(row.id)) {
      // The two tables' id sequences grow independently, so this can happen when a migration
      // first applied from src/db/migrations is moved after local migrations have run.
      refusals.push(
        `${row.name} (${UPSTREAM_MIGRATIONS_TABLE} id ${row.id}) can't keep its id: ${LOCAL_MIGRATIONS_TABLE} already has a row with id ${row.id}. `
        + `Give the ${UPSTREAM_MIGRATIONS_TABLE} row an unused id by hand (keep its run_on).`,
      );
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
  if (orderCheck.upstream.status === 'failed') {
    refusals.push(`The upstream track would fail its order check: ${orderCheck.upstream.message}.`);
  }
  let proposedRenames: Array<{ from: string; to: string }> = [];
  if (orderCheck.local.status === 'failed') {
    proposedRenames = proposeLocalRenames(mergedLocal, localFiles);
    refusals.push(
      `The local track would fail its order check: ${orderCheck.local.message}. Its migrations were applied in a different order from their filenames; `
      + 'rename the files and their history rows together (the dry run proposes the renames).',
    );
  }

  return { moves, refusals, orderCheck, proposedRenames };
}

/**
 * The upstream-only case, for the dry run: what node-pg-migrate's own order check will say at
 * boot when there is no local track. This is how a fork that has not moved its migrations
 * yet sees the failure the local track exists to fix.
 */
function planUpstreamOnly(upstreamFiles: string[], upstreamHistory: HistoryRow[]): ReconciliationPlan {
  const upstream = checkTrackOrder(upstreamHistory.map(row => row.name), upstreamFiles);
  const refusals = upstream.status === 'failed'
    ? [
      `Boot will fail node-pg-migrate's order check: ${upstream.message}. If this is a fork with its own migrations in `
      + 'src/db/migrations, move them to the local track first (docs/dev/fork-migrations.md).',
    ]
    : [];
  return { moves: [], refusals, orderCheck: { upstream, local: { status: 'not-run' } }, proposedRenames: [] };
}

/** True when boot reconciles and runs the local track. */
function localTrackInUse(localFiles: unknown[], localHistory: unknown[]): boolean {
  return localFiles.length > 0 || localHistory.length > 0;
}

/** Records errors that happened while handling `err`, without replacing it. */
function attachSuppressed(err: unknown, suppressed: unknown): void {
  if (!(err instanceof Error)) return;
  const holder = err as Error & { suppressed?: unknown[] };
  holder.suppressed = [...(holder.suppressed ?? []), suppressed];
}

/**
 * Runs `fn` on a connection of its own, always closing it. The original error always wins:
 * a failure to close, or a connection error reported alongside it, is attached to it rather
 * than thrown in its place.
 */
async function withClient<T>(databaseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  // Without a listener, a connection dropped between queries is an uncaught exception that
  // crashes the process with no migration context. The query in flight, or the next one,
  // rejects too; this keeps the event so it can be attached to that rejection.
  let connectionError: unknown;
  client.on('error', (err: Error) => { connectionError = err; });
  await client.connect();
  try {
    const result = await fn(client);
    await client.end();
    return result;
  } catch (err) {
    if (connectionError !== undefined && connectionError !== err) attachSuppressed(err, connectionError);
    await client.end().catch((endErr: unknown) => attachSuppressed(err, endErr));
    throw err;
  }
}

type Queryable = Pick<pg.ClientBase, 'query'>;

async function tableExists(db: Queryable, table: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${table}`]);
  return rows[0]!.exists;
}

async function readHistory(db: Queryable, table: typeof UPSTREAM_MIGRATIONS_TABLE | typeof LOCAL_MIGRATIONS_TABLE): Promise<HistoryRow[]> {
  if (!(await tableExists(db, table))) return [];
  // pgmigrations is node-pg-migrate's own; the local table is ours to vouch for.
  if (table === LOCAL_MIGRATIONS_TABLE) await assertLocalTableShape(db);
  // The table name is one of two constants, never input.
  const { rows } = await db.query<{ id: number; name: string; run_on_us: string }>(
    `SELECT id, name, (extract(epoch FROM run_on) * 1000000)::bigint::text AS run_on_us
       FROM public.${table} ORDER BY run_on, id`,
  );
  return rows.map(row => ({ id: row.id, name: row.name, runOnMicros: BigInt(row.run_on_us) }));
}

/**
 * `CREATE TABLE IF NOT EXISTS` accepts a table of any shape, so check the one that is there
 * is node-pg-migrate's: id with a sequence, name and run_on. Anything else fails here, by
 * name, instead of later inside setval or node-pg-migrate.
 */
async function assertLocalTableShape(db: Queryable): Promise<void> {
  const { rows: columns } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [LOCAL_MIGRATIONS_TABLE],
  );
  const names = new Set(columns.map(c => c.column_name));
  const missing = ['id', 'name', 'run_on'].filter(c => !names.has(c));
  let sequence: string | null = null;
  if (missing.length === 0) {
    const { rows } = await db.query<{ seq: string | null }>(
      `SELECT pg_get_serial_sequence('public.${LOCAL_MIGRATIONS_TABLE}', 'id') AS seq`,
    );
    sequence = rows[0]!.seq;
  }
  if (missing.length > 0 || sequence === null) {
    const found = [...names].sort().join(', ') || 'no columns';
    throw new Error(
      `${LOCAL_MIGRATIONS_TABLE} exists but is not a node-pg-migrate history table `
      + `(needs id with a sequence, name and run_on; found ${found}${missing.length === 0 ? ' and no sequence on id' : ''}). `
      + 'Curia did not create it: rename or drop it, then start again.',
    );
  }
}

/**
 * Moves applied fork migrations from pgmigrations to pgmigrations_local, in one transaction
 * under node-pg-migrate's advisory lock. Throws MigrationReconciliationError, writing
 * nothing, when the plan refuses. A second run finds nothing to move. When the local track
 * is not in use it writes nothing and checks nothing.
 */
async function reconcile(
  databaseUrl: string,
  upstreamFiles: string[],
  localFiles: string[],
): Promise<{ inUse: boolean; moved: string[] }> {
  return withClient(databaseUrl, async client => {
    await client.query('BEGIN');
    try {
      const { rows: [lock] } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
        [String(PG_MIGRATE_LOCK_ID)],
      );
      if (!lock!.locked) throw new Error('Another migration is already running.');

      const localTableExists = await tableExists(client, LOCAL_MIGRATIONS_TABLE);
      const localHistory = localTableExists ? await readHistory(client, LOCAL_MIGRATIONS_TABLE) : [];
      if (!localTrackInUse(localFiles, localHistory)) {
        await client.query('COMMIT');
        return { inUse: false, moved: [] };
      }

      if (!localTableExists) {
        // The same shape node-pg-migrate creates, so its own check accepts the table.
        await client.query(
          `CREATE TABLE public.${LOCAL_MIGRATIONS_TABLE} (id SERIAL PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL)`,
        );
      }
      const plan = planReconciliation({
        upstreamFiles,
        localFiles,
        upstreamHistory: await readHistory(client, UPSTREAM_MIGRATIONS_TABLE),
        localHistory,
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
      return { inUse: true, moved };
    } catch (err) {
      // Postgres discards an open transaction when its connection drops, so a failed ROLLBACK
      // loses nothing. Keep the original error: it says what actually went wrong.
      await client.query('ROLLBACK').catch((rollbackErr: unknown) => attachSuppressed(err, rollbackErr));
      throw err;
    }
  });
}

/**
 * Applies pending migrations: reconciliation, then upstream into pgmigrations, then local
 * into pgmigrations_local. Reconciliation and the local run happen only when the local
 * track is in use (see the header comment).
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const { databaseUrl, dirs, log, count } = options;
  const upstreamFiles = await listMigrationFiles(dirs.upstream, 'upstream');
  const localFiles = await listLocalFiles(dirs);

  const { inUse, moved } = count === undefined
    ? await reconcile(databaseUrl, upstreamFiles.map(f => f.name), localFiles.map(f => f.name))
    : { inUse: false, moved: [] };

  const upstream = await runner({
    databaseUrl,
    dir: dirs.upstream,
    migrationsTable: UPSTREAM_MIGRATIONS_TABLE,
    direction: 'up',
    count,
    log,
  });
  // In use with no files can't get here: reconciliation refuses history rows with no file.
  const local = inUse && localFiles.length > 0
    ? await runner({
      databaseUrl,
      dir: dirs.local,
      ignorePattern: LOCAL_IGNORE_PATTERN,
      migrationsTable: LOCAL_MIGRATIONS_TABLE,
      direction: 'up',
      log,
    })
    : [];

  return {
    upstream: upstream.map(m => m.name),
    local: local.map(m => m.name),
    moved,
    localTrackInUse: inUse,
    localDir: dirs.local,
    localFileCount: localFiles.length,
  };
}

async function createdObjects(files: MigrationFile[]): Promise<Array<{ file: string; objects: SchemaObject[] }>> {
  return Promise.all(files.map(async f => ({ file: f.name, objects: extractCreatedObjects(await readFile(f.path, 'utf8')) })));
}

function objectKey(o: SchemaObject): string {
  return `${o.kind}:${o.name}`;
}

/**
 * What boot would do on this database, without writing: the moves, the order check on each
 * track, any refusals and proposed renames, and the schema objects both tracks create (an
 * overlap a name match can't see). It decides whether the local track is in use exactly as
 * boot does, so the two never disagree.
 */
export async function dryRunReconciliation(databaseUrl: string, dirs: MigrationDirs): Promise<DryRunReport> {
  const upstreamFiles = await listMigrationFiles(dirs.upstream, 'upstream');
  const localFiles = await listLocalFiles(dirs);

  const history = await withClient(databaseUrl, async client => ({
    tables: {
      upstream: await tableExists(client, UPSTREAM_MIGRATIONS_TABLE),
      local: await tableExists(client, LOCAL_MIGRATIONS_TABLE),
    },
    upstream: await readHistory(client, UPSTREAM_MIGRATIONS_TABLE),
    local: await readHistory(client, LOCAL_MIGRATIONS_TABLE),
  }));

  const inUse = localTrackInUse(localFiles, history.local);
  const plan = inUse
    ? planReconciliation({
      upstreamFiles: upstreamFiles.map(f => f.name),
      localFiles: localFiles.map(f => f.name),
      upstreamHistory: history.upstream,
      localHistory: history.local,
    })
    : planUpstreamOnly(upstreamFiles.map(f => f.name), history.upstream);

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
    localHistory: history.local.map(row => row.name),
    historyTables: history.tables,
    localTrackInUse: inUse,
    plan,
    localObjects,
    upstreamObjectCount: upstreamByKey.size,
    overlaps: [...overlapsByKey.values()],
  };
}

/** 0: boot would go ahead. 1: boot would stop (refusals). 2: it would go ahead, but check the warnings. */
export function dryRunExitCode(report: DryRunReport): 0 | 1 | 2 {
  if (report.plan.refusals.length > 0) return 1;
  if (report.overlaps.length > 0) return 2;
  return 0;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A POSIX shell single-quoted word, safe to paste whatever the path holds. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function describeObject(o: SchemaObject): string {
  return `${o.kind} ${o.name}`;
}

function describeOrderCheck(check: OrderCheck): string {
  switch (check.status) {
    case 'ok': return 'ok';
    case 'failed': return `FAILS — ${check.message}`;
    case 'not-run': return 'not run';
  }
}

/** The dry run as text for an operator. */
export function formatDryRunReport(report: DryRunReport): string {
  const { plan } = report;
  const lines: string[] = [
    'Migration dry run — nothing has been written.',
    '',
    `Upstream directory: ${report.dirs.upstream} (${report.upstreamFiles.length} migrations)`,
    `Local directory:    ${report.dirs.local} (${report.localFiles.length} migrations)`,
    '',
  ];
  if (!report.historyTables.upstream) {
    lines.push(
      `${UPSTREAM_MIGRATIONS_TABLE} not found: this database has never been migrated. Check DATABASE_URL points at the`,
      'database you meant (for a fork moving its migrations, a copy of production).',
      '',
    );
  }

  if (!report.localTrackInUse) {
    lines.push(
      `No local migrations and no ${LOCAL_MIGRATIONS_TABLE} history: boot runs the upstream track alone, as before.`,
      '',
      `Order check (upstream, as node-pg-migrate runs it at boot): ${describeOrderCheck(plan.orderCheck.upstream)}`,
    );
  } else {
    lines.push(`Planned moves from ${UPSTREAM_MIGRATIONS_TABLE} to ${LOCAL_MIGRATIONS_TABLE} (${plan.moves.length}):`);
    if (plan.moves.length === 0) lines.push('  (none)');
    for (const row of plan.moves) lines.push(`  - ${row.name} (id ${row.id})`);
    lines.push('', 'Order check after the moves:');
    for (const track of ['upstream', 'local'] as const) {
      lines.push(`  ${track}: ${describeOrderCheck(plan.orderCheck[track])}`);
    }

    if (plan.proposedRenames.length > 0) {
      lines.push('', 'Proposed renames for the local track (apply the files and the rows together):');
      // Two steps each, so a new name that equals another file's or row's old name never
      // collides partway through.
      const filePath = new Map(report.localFiles.map(f => [f.name, f.path]));
      for (const { from } of plan.proposedRenames) {
        const current = filePath.get(from)!;
        lines.push(`  git mv ${shellQuote(current)} ${shellQuote(`${current}.renaming`)}`);
      }
      for (const { from, to } of plan.proposedRenames) {
        const current = filePath.get(from)!;
        const target = path.join(path.dirname(current), to + path.extname(current));
        lines.push(`  git mv ${shellQuote(`${current}.renaming`)} ${shellQuote(target)}`);
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
    if (report.localObjects.length === 0) lines.push('  (no local migration files)');
    for (const { file, objects } of report.localObjects) {
      lines.push(`  ${file}: ${objects.length > 0 ? objects.map(describeObject).join(', ') : '(none found)'}`);
    }
    lines.push(`  (The upstream migrations create ${report.upstreamObjectCount} distinct tables, columns and indexes.)`);

    lines.push('', 'Objects created on both tracks:');
    if (report.overlaps.length === 0) lines.push('  (none detected — this is a text match over the SQL, not proof)');
    for (const overlap of report.overlaps) {
      lines.push(`  WARNING ${describeObject(overlap.object)}: upstream ${overlap.upstreamFiles.join(', ')}; local ${overlap.localFiles.join(', ')}`);
    }
    if (report.overlaps.length > 0) {
      lines.push('  An upstream migration that recreates one of these may fail, or skip it, on this database. Check each by hand.');
    }
  }

  lines.push('');
  if (plan.refusals.length > 0) {
    lines.push('Boot would STOP:');
    for (const refusal of plan.refusals) lines.push(`  - ${refusal}`);
  } else if (report.overlaps.length > 0) {
    lines.push('Boot would go ahead, but check the warnings above.');
  } else {
    lines.push('Boot would go ahead.');
  }
  return lines.join('\n');
}
