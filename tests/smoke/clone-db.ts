// tests/smoke/clone-db.ts — run smoke on a throwaway copy of the database (#1956).
//
// Smoke runs real tools, and a run writes contacts, knowledge-graph facts and
// config-store settings (one baseline run on the dev database added 17 contacts and
// stored a fake Zoom link as the principal's). Running on a copy keeps all of that out
// of the database a real instance reads, and every run starts from the same state
// instead of the residue of earlier runs.
//
// The copy is CREATE DATABASE … TEMPLATE <source>: a file-level copy, so the vault,
// the principal, the registry and every migration come along. Postgres requires that
// nothing else is connected to the source while it copies — stop the dev instance first.
import pg from 'pg';

/** Clones are named `<source>_smoke_<pid>`; a stale one is found by this infix. */
const CLONE_INFIX = '_smoke_';

export interface DatabaseClone {
  /** DATABASE_URL pointing at the clone. */
  url: string;
  name: string;
  /** Drop the clone, disconnecting anything still attached. Safe to call twice. */
  drop(): Promise<void>;
}

/** The source database's name, from its URL. Restricted so it can be quoted safely. */
export function databaseName(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`smoke: database name '${name}' must be letters, digits and underscores to clone it`);
  }
  return name;
}

export function cloneName(source: string, pid: number): string {
  const name = `${source}${CLONE_INFIX}${pid}`;
  // Postgres truncates identifiers at 63 bytes; a truncated name could collide.
  if (name.length > 63) throw new Error(`smoke: clone name '${name}' exceeds Postgres's 63-character limit`);
  return name;
}

function withDatabase(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Run `fn` on a connection to the server's maintenance database (never the source). */
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
 * Copy `databaseUrl`'s database to a fresh clone and return it. Drops clones that
 * crashed runs left behind first (any `<source>_smoke_*` with no connections).
 */
export async function cloneDatabase(databaseUrl: string): Promise<DatabaseClone & { removedStale: string[] }> {
  const source = databaseName(databaseUrl);
  const name = cloneName(source, process.pid);

  const removedStale = await withAdmin(databaseUrl, async (admin) => {
    // LIKE treats `_` as a wildcard; escape it so only our own naming scheme matches.
    const pattern = `${source}${CLONE_INFIX}`.replace(/_/g, '\\_') + '%';
    const stale = await admin.query<{ datname: string }>(
      `SELECT d.datname FROM pg_database d
        WHERE d.datname LIKE $1
          AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
      [pattern],
    );
    for (const row of stale.rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(row.datname)}`);
    }

    try {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE ${admin.escapeIdentifier(source)}`);
    } catch (err) {
      // 55006 object_in_use: something is connected to the source.
      if ((err as { code?: string }).code === '55006') {
        const clients = await admin.query<{ application: string; count: string }>(
          `SELECT coalesce(nullif(application_name, ''), '(unnamed)') AS application, count(*)::text AS count
             FROM pg_stat_activity WHERE datname = $1 GROUP BY 1 ORDER BY 1`,
          [source],
        );
        const list = clients.rows.map(r => `${r.application} ×${r.count}`).join(', ') || 'unknown clients';
        throw new Error(
          `smoke copies '${source}' to a throwaway database, and Postgres refuses while other clients ` +
          `are connected to it (${list}). Stop the dev instance (docker stop curia-curia-1) and any ` +
          `psql sessions on '${source}', then re-run.`,
        );
      }
      throw err;
    }
    return stale.rows.map(r => r.datname);
  });

  let dropped = false;
  return {
    url: withDatabase(databaseUrl, name),
    name,
    removedStale,
    async drop() {
      if (dropped) return;
      // FORCE (PG13+) ends any session still attached, e.g. a late turn's pool.
      await withAdmin(databaseUrl, admin => admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`));
      dropped = true;
    },
  };
}
