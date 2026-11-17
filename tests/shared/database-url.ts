// tests/shared/database-url.ts — reading and quoting database names in test tooling that
// creates throwaway databases (the setup-wizard walkthrough). Moved from the retired smoke
// suite's clone-db.ts.

/** The database's name, from its URL. Restricted so it can be quoted safely in SQL. */
export function databaseName(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`database name '${name}' must be letters, digits and underscores`);
  }
  return name;
}

/**
 * Whether the URL points at a local server. Tooling that creates or drops databases refuses
 * a remote one, so it never copies or sweeps a real server's data by mistake.
 */
export function isLocalDatabase(databaseUrl: string): boolean {
  const host = decodeURIComponent(new URL(databaseUrl).hostname).replace(/^\[|\]$/g, '');
  return host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('/');
}

/**
 * A LIKE pattern matching names that start with `prefix`. Escapes LIKE's default escape
 * character `\` as well as its `%` and `_` wildcards, in one pass so none is doubled.
 */
export function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, '\\$&') + '%';
}
