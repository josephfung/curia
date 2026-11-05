// A freshly migrated database of its own, for an integration suite whose DDL would break
// the other files sharing curia_test (resizing kg_nodes.embedding, for example). Files run
// in parallel against one database, so a column change there fails their inserts.
//
// Created beside curia_test on the same server, and only when DATABASE_URL points at
// curia_test, so a mispointed URL never creates or drops anything elsewhere.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { resolveMigrationDirs, runMigrations } from '../../src/db/run-migrations.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

export interface ScratchDatabase {
  url: string;
  /** Drops the database, disconnecting anything still attached. Safe to call twice. */
  drop(): Promise<void>;
}

function withDatabase(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin<T>(databaseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: withDatabase(databaseUrl, 'postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * `label` is letters, digits and underscores; it names the database, so it is quoted safely.
 * `migrations` applies only that many upstream migrations, oldest first, for a test of one
 * migration; the local track is then skipped. `0` leaves the database empty apart from
 * node-pg-migrate's history table.
 */
export async function createScratchDatabase(
  sourceUrl: string,
  label: string,
  options: { migrations?: number } = {},
): Promise<ScratchDatabase> {
  if (!/^[a-z0-9_]+$/.test(label)) throw new Error(`scratch database label '${label}' must be [a-z0-9_]`);
  const guard = new pg.Pool({ connectionString: sourceUrl });
  try {
    await requireCuriaTestDatabase(guard);
  } finally {
    await guard.end();
  }

  const name = `curia_test_${label}_${randomBytes(4).toString('hex')}`;
  if (name.length > 63) throw new Error(`scratch database name '${name}' exceeds Postgres's 63-character limit`);
  await withAdmin(sourceUrl, client => client.query(`CREATE DATABASE "${name}"`));

  let dropped = false;
  const drop = async (): Promise<void> => {
    if (dropped) return;
    dropped = true;
    await withAdmin(sourceUrl, client => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  };

  const url = withDatabase(sourceUrl, name);
  try {
    await runMigrations({
      databaseUrl: url,
      dirs: resolveMigrationDirs(PROJECT_ROOT),
      count: options.migrations,
      log: () => { /* per-migration lines are noise in test output */ },
    });
  } catch (err) {
    await drop();
    throw err;
  }
  return { url, drop };
}
