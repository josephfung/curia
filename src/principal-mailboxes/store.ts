// PrincipalMailboxStore — persistence for the principal_mailboxes registry (#2475).
// Rows are never deleted: tombstone() sets removed_at so an id stays taken.
import type { Pool, PoolClient } from 'pg';
import type { Logger } from '../logger.js';
import { RemovedMailboxError, UnknownMailboxError, type PrincipalMailboxRecord } from './types.js';

interface MailboxRow {
  id: string;
  label: string;
  address: string;
  provider: string;
  is_default: boolean;
  triage_start_at: Date | null;
  removed_at: Date | null;
  added_identity_id: string | null;
}

const COLUMNS =
  'id, label, address, provider, is_default, triage_start_at, removed_at, added_identity_id';

function toRecord(row: MailboxRow): PrincipalMailboxRecord {
  return {
    id: row.id,
    label: row.label,
    address: row.address,
    // The column is free text with a default; 'google' is the only provider that exists.
    provider: 'google',
    isDefault: row.is_default,
    triageStartAt: row.triage_start_at,
    removedAt: row.removed_at,
    addedIdentityId: row.added_identity_id,
  };
}

export class PrincipalMailboxStore {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  /** Live (not removed) mailboxes: the default first, then oldest first. */
  async listLive(): Promise<PrincipalMailboxRecord[]> {
    const { rows } = await this.pool.query<MailboxRow>(
      `SELECT ${COLUMNS} FROM principal_mailboxes
        WHERE removed_at IS NULL
        ORDER BY is_default DESC, created_at ASC, id ASC`,
    );
    return rows.map(toRecord);
  }

  /** True when the table has any row, removed ones included. */
  async hasAnyRow(): Promise<boolean> {
    const { rows } = await this.pool.query<{ found: number }>(
      'SELECT 1 AS found FROM principal_mailboxes LIMIT 1',
    );
    return rows.length > 0;
  }

  /** A mailbox by id, removed ones included; null when the id was never registered. */
  async getAny(id: string): Promise<PrincipalMailboxRecord | null> {
    const { rows } = await this.pool.query<MailboxRow>(
      `SELECT ${COLUMNS} FROM principal_mailboxes WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Insert a mailbox. An `isDefault` record takes over as the one live default: the current
   * default is cleared and the row inserted in ONE transaction, so a failed insert leaves the
   * old default in place. Pass `client` to join the caller's transaction (it is then the
   * transaction and this method neither begins nor commits).
   */
  async insert(r: Omit<PrincipalMailboxRecord, 'removedAt'>, client?: PoolClient): Promise<void> {
    const run = async (db: Pick<Pool, 'query'>): Promise<void> => {
      if (r.isDefault) {
        await db.query(
          `UPDATE principal_mailboxes SET is_default = false, updated_at = now()
            WHERE is_default AND removed_at IS NULL`,
        );
      }
      await db.query(
        `INSERT INTO principal_mailboxes
           (id, label, address, provider, is_default, triage_start_at, added_identity_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.id, r.label, r.address, r.provider, r.isDefault, r.triageStartAt, r.addedIdentityId],
      );
    };
    if (client) await run(client);
    else await this.inTransaction(run);
    this.logger.info({ mailboxId: r.id, isDefault: r.isDefault }, 'Principal mailbox registered');
  }

  async relabel(id: string, label: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE principal_mailboxes SET label = $2, updated_at = now()
        WHERE id = $1 AND removed_at IS NULL`,
      [id, label],
    );
    if (res.rowCount === 0) await this.throwNotLive(id);
  }

  /** Make `id` the one live default. Clearing the old default and setting the new one is atomic. */
  async setDefault(id: string): Promise<void> {
    await this.inTransaction(async (client) => {
      await this.assignDefault(client, id);
    });
    this.logger.info({ mailboxId: id }, 'Principal mailbox default changed');
  }

  /**
   * Mark `id` removed. A live default can go only when it is the last live mailbox or
   * `newDefaultId` names another live one to take over; otherwise the registry would be left
   * with live mailboxes and no default.
   */
  async tombstone(id: string, newDefaultId: string | null): Promise<void> {
    await this.inTransaction(async (client) => {
      const { rows } = await client.query<MailboxRow>(
        `SELECT ${COLUMNS} FROM principal_mailboxes WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = rows[0];
      if (!row) throw new UnknownMailboxError(id);
      if (row.removed_at) throw new RemovedMailboxError(id, row.label);
      if (newDefaultId === id) {
        throw new Error(`Mailbox "${id}" cannot be its own replacement default`);
      }

      if (row.is_default && newDefaultId === null) {
        const others = await client.query<{ id: string }>(
          'SELECT id FROM principal_mailboxes WHERE removed_at IS NULL AND id <> $1',
          [id],
        );
        if (others.rows.length > 0) {
          throw new Error(
            `Mailbox "${id}" is the default; name a new default before removing it`,
          );
        }
      }

      await client.query(
        `UPDATE principal_mailboxes
            SET removed_at = now(), is_default = false, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      if (newDefaultId !== null) await this.assignDefault(client, newDefaultId);
    });
    this.logger.info({ mailboxId: id, newDefaultId }, 'Principal mailbox removed');
  }

  /** Clear the live default, then set `id`. Runs inside the caller's transaction. */
  private async assignDefault(client: PoolClient, id: string): Promise<void> {
    const { rows } = await client.query<MailboxRow>(
      `SELECT ${COLUMNS} FROM principal_mailboxes WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new UnknownMailboxError(id);
    if (row.removed_at) throw new RemovedMailboxError(id, row.label);
    await client.query(
      `UPDATE principal_mailboxes SET is_default = false, updated_at = now()
        WHERE is_default AND removed_at IS NULL AND id <> $1`,
      [id],
    );
    await client.query(
      'UPDATE principal_mailboxes SET is_default = true, updated_at = now() WHERE id = $1',
      [id],
    );
  }

  private async throwNotLive(id: string): Promise<never> {
    const existing = await this.getAny(id);
    if (!existing) throw new UnknownMailboxError(id);
    throw new RemovedMailboxError(id, existing.label);
  }

  private async inTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await fn(client);
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        this.logger.error({ err: rollbackErr }, 'Principal mailbox transaction rollback failed');
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
