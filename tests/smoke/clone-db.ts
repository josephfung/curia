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
//
// Ownership: a run holds a session advisory lock named after its clone, on a dedicated
// connection to the maintenance database, for its whole life. The start-up sweep drops
// a leftover clone only if it can take that lock — so a parallel run (another worktree)
// whose clone sits idle while it waits on the model is never mistaken for a crashed one.
// Advisory locks are per database; every run takes them in `postgres`, so they meet.
import pg from 'pg';

/** Clones are named `<source>_smoke_<pid>`; a stale one is found by this infix. */
const CLONE_INFIX = '_smoke_';
const MAINTENANCE_DB = 'postgres';

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

/**
 * Hosts smoke will copy a database on. Its whole point is to keep test writes away from
 * a real database; pointed at a remote server it would copy that server's data (vault
 * ciphertext included) and sweep its databases. `--allow-remote-db` overrides.
 */
export function isLocalDatabase(databaseUrl: string): boolean {
  const host = decodeURIComponent(new URL(databaseUrl).hostname).replace(/^\[|\]$/g, '');
  return host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('/');
}

/** Exactly what cloneName() produces for `source`, so the sweep can't touch a database someone named by hand. */
export function isCloneOf(datname: string, source: string): boolean {
  return datname.startsWith(`${source}${CLONE_INFIX}`) && /^\d+$/.test(datname.slice(source.length + CLONE_INFIX.length));
}

/** A connection to the server's maintenance database (`postgres`). */
async function connectAdmin(databaseUrl: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: withDatabase(databaseUrl, MAINTENANCE_DB) });
  await client.connect();
  return client;
}

/**
 * Copy `databaseUrl`'s database to a fresh clone and return it. Drops clones that crashed
 * runs left behind first: `<source>_smoke_<digits>`, unowned (lock free) and unconnected.
 */
export async function cloneDatabase(databaseUrl: string): Promise<DatabaseClone & { removedStale: string[] }> {
  const source = databaseName(databaseUrl);
  const name = cloneName(source, process.pid);
  if (source === MAINTENANCE_DB) throw new Error(`smoke: DATABASE_URL names '${MAINTENANCE_DB}' itself; point it at the app database`);

  // Held open for the run: it carries the ownership lock.
  const owner = await connectAdmin(databaseUrl);
  let removedStale: string[];
  try {
    // Take our own lock before the clone exists, so no other run's sweep can drop it.
    await owner.query(`SELECT pg_advisory_lock(hashtext($1))`, [name]);

    const candidates = await owner.query<{ datname: string }>(
      `SELECT d.datname FROM pg_database d
        WHERE d.datname LIKE $1
          AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
      // LIKE treats `_` as a wildcard; escaped here, and isCloneOf() below is exact anyway.
      [`${source}${CLONE_INFIX}`.replace(/_/g, '\\_') + '%'],
    );
    removedStale = [];
    for (const { datname } of candidates.rows) {
      if (datname === name || !isCloneOf(datname, source)) continue;
      const lock = await owner.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [datname]);
      if (!lock.rows[0]?.locked) continue; // a live run owns it
      try {
        // No FORCE: a session that attached since the SELECT makes this fail, not get killed.
        await owner.query(`DROP DATABASE IF EXISTS ${owner.escapeIdentifier(datname)}`);
        removedStale.push(datname);
      } finally {
        await owner.query(`SELECT pg_advisory_unlock(hashtext($1))`, [datname]);
      }
    }

    try {
      await owner.query(`CREATE DATABASE ${owner.escapeIdentifier(name)} TEMPLATE ${owner.escapeIdentifier(source)}`);
    } catch (err) {
      // 55006 object_in_use: something is connected to the source.
      if ((err as { code?: string }).code === '55006') {
        const clients = await owner.query<{ application: string; count: string }>(
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
  } catch (err) {
    // Closing the session releases the lock too.
    await owner.end().catch(() => undefined);
    throw err;
  }

  let dropped = false;
  return {
    url: withDatabase(databaseUrl, name),
    name,
    removedStale,
    async drop() {
      if (dropped) return;
      try {
        // FORCE (PG13+) ends any session still attached, e.g. a late turn's pool.
        await owner.query(`DROP DATABASE IF EXISTS ${owner.escapeIdentifier(name)} WITH (FORCE)`);
        dropped = true;
      } finally {
        // Ending the owner session releases the lock: a clone left behind by a failed drop
        // is then unowned, and the next run's sweep removes it.
        await owner.end().catch(() => undefined);
      }
    },
  };
}
