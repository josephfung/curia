import type { DbPool } from '../../db/connection.js';

export interface EmailAccountRow {
  name: string;
  selfEmail: string;
  provider: string;
  enabled: boolean;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
}

// Internal shape returned by pg — snake_case columns from the email_accounts table.
interface DbEmailAccount {
  name: string;
  self_email: string;
  provider: string;
  enabled: boolean;
  created_at: Date;
  created_by: string;
  updated_at: Date;
}

// Column list for SELECT and RETURNING clauses — kept in one place to avoid drift.
const COLS = 'name, self_email, provider, enabled, created_at, created_by, updated_at';

// Map a raw db row (snake_case) to the public camelCase interface.
function mapRow(r: DbEmailAccount): EmailAccountRow {
  return {
    name: r.name,
    selfEmail: r.self_email,
    provider: r.provider,
    enabled: r.enabled,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
  };
}

export interface CreateEmailAccountInput {
  name: string;
  selfEmail: string;
  /** Defaults to 'nylas' in the DB. */
  provider?: string;
  /** Defaults to true in the DB. */
  enabled?: boolean;
  /** Defaults to 'web-console' in the DB. */
  createdBy?: string;
}

/**
 * Repository for the `email_accounts` table (migration 064).
 *
 * Each row represents a mailbox the agent owns — the non-secret identity of
 * the account. Secrets (Nylas grant IDs) live separately in the vault under
 * `channel.email.<name>.nylas_grant_id`.
 *
 * All methods use parameterized queries; never interpolate variables into SQL.
 */
/** How many suffixed names createForAddress tries before giving up. */
const MAX_NAME_SUFFIX = 50;
const MAX_NAME_LENGTH = 40;

/**
 * An account name from an address's local part, matching EMAIL_ACCOUNT_NAME_RE: lowercased,
 * anything outside [a-z0-9_-] becomes '-', leading/trailing separators trimmed, 'mailbox' when
 * nothing is left.
 */
export function emailAccountNameFromAddress(address: string): string {
  const local = address.trim().toLowerCase().split('@')[0] ?? '';
  const slug = local
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[-_]+$/, '');
  return slug === '' ? 'mailbox' : slug;
}

/** How long the ceo-inbox tools wait for listSelfEmails, and its statement timeout (#2409). */
export const CURIA_ADDRESS_LOOKUP_TIMEOUT_MS = 3000;

export class EmailAccountsRepo {
  constructor(private readonly pool: DbPool) {}

  /** Return all accounts ordered by name ascending. */
  async list(): Promise<EmailAccountRow[]> {
    const { rows } = await this.pool.query<DbEmailAccount>(
      `SELECT ${COLS} FROM email_accounts ORDER BY name ASC`,
    );
    return rows.map(mapRow);
  }

  /**
   * Every account's address, with a server-side statement timeout. For the ceo-inbox tools'
   * per-call Curia-mail filter (#2409): their caller stops waiting after a few seconds, and the
   * timeout makes Postgres cancel a stalled read too, so it can't keep holding a pool connection.
   */
  async listSelfEmails(statementTimeoutMs: number): Promise<string[]> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      // set_config(..., true) is SET LOCAL with a bind parameter: it ends with the transaction.
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${statementTimeoutMs}ms`]);
      const { rows } = await client.query<{ self_email: string }>(
        'SELECT self_email FROM email_accounts ORDER BY name ASC',
      );
      await client.query('COMMIT');
      return rows.map(r => r.self_email);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // The connection is in an unknown state: have the pool destroy it, not reuse it.
        // The caller still gets the original error below.
        broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  /** Return one account by its logical name, or null if not found. */
  async get(name: string): Promise<EmailAccountRow | null> {
    const { rows } = await this.pool.query<DbEmailAccount>(
      `SELECT ${COLS} FROM email_accounts WHERE name = $1`,
      [name],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Return the total count of accounts.
   *
   * The `::int` cast converts PostgreSQL's text `count(*)` result to a JS number
   * directly. Without it, pg returns the count as a string and `Number()` is needed.
   */
  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM email_accounts',
    );
    return rows[0] ? Number(rows[0].count) : 0;
  }

  /**
   * Insert a new account row.
   *
   * `provider`, `enabled`, and `createdBy` fall back to their DB-level defaults
   * (nylas / true / web-console) when not provided — we pass them as null and
   * use COALESCE so the DB default is never duplicated in application code.
   */
  async create(input: CreateEmailAccountInput): Promise<EmailAccountRow> {
    const { rows } = await this.pool.query<DbEmailAccount>(
      `INSERT INTO email_accounts (name, self_email, provider, enabled, created_by)
       VALUES ($1, $2, COALESCE($3, 'nylas'), COALESCE($4, true), COALESCE($5, 'web-console'))
       RETURNING ${COLS}`,
      [input.name, input.selfEmail, input.provider ?? null, input.enabled ?? null, input.createdBy ?? null],
    );
    if (!rows[0]) throw new Error(`create: INSERT returned no row for email account '${input.name}'`);
    return mapRow(rows[0]);
  }

  /** The account whose address is `selfEmail` (case-insensitive), or null. The oldest name wins a tie. */
  async findBySelfEmail(selfEmail: string): Promise<EmailAccountRow | null> {
    const { rows } = await this.pool.query<DbEmailAccount>(
      `SELECT ${COLS} FROM email_accounts WHERE lower(self_email) = lower($1) ORDER BY created_at ASC, name ASC LIMIT 1`,
      [selfEmail.trim()],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Insert an account for `selfEmail` under the first free name (#2361 sign-in): `preferName`
   * when given, then the slug of the address's local part, then that slug suffixed -2, -3, ….
   * ON CONFLICT DO NOTHING makes each try atomic, so a name taken meanwhile just moves on.
   */
  async createForAddress(
    selfEmail: string,
    opts: { createdBy: string; preferName?: string },
  ): Promise<EmailAccountRow> {
    const slug = emailAccountNameFromAddress(selfEmail);
    const candidates = [
      ...(opts.preferName !== undefined ? [opts.preferName] : []),
      slug,
      ...Array.from({ length: MAX_NAME_SUFFIX - 1 }, (_, i) => `${slug}-${i + 2}`),
    ];
    for (const name of candidates) {
      const { rows } = await this.pool.query<DbEmailAccount>(
        `INSERT INTO email_accounts (name, self_email, provider, enabled, created_by)
         VALUES ($1, $2, 'nylas', true, $3)
         ON CONFLICT (name) DO NOTHING
         RETURNING ${COLS}`,
        [name, selfEmail.trim(), opts.createdBy],
      );
      if (rows[0]) return mapRow(rows[0]);
    }
    throw new Error(`createForAddress: no free account name after ${candidates.length} tries`);
  }

  /**
   * Partially update an account's mutable fields (`selfEmail`, `enabled`).
   * COALESCE keeps the existing DB value when a patch field is omitted (passed as null).
   *
   * Returns the updated row, or null if no account with `name` exists.
   */
  async update(name: string, patch: { selfEmail?: string; enabled?: boolean }): Promise<EmailAccountRow | null> {
    const { rows } = await this.pool.query<DbEmailAccount>(
      `UPDATE email_accounts
          SET self_email = COALESCE($2, self_email),
              enabled    = COALESCE($3, enabled),
              updated_at = now()
        WHERE name = $1
        RETURNING ${COLS}`,
      [name, patch.selfEmail ?? null, patch.enabled ?? null],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Delete an account by name.
   *
   * Returns true if a row was deleted, false if no matching account existed.
   * `rowCount` may be null when pg cannot determine the count (non-DML statements);
   * for DELETE it is always an integer, so `?? 0` is a defensive guard.
   */
  async delete(name: string): Promise<boolean> {
    const res = await this.pool.query(
      'DELETE FROM email_accounts WHERE name = $1',
      [name],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
