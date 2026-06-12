// src/registry/channel-registry-repo.ts
// Postgres-backed channel_registry access. Parameterized queries only.
import type { DbPool } from '../db/connection.js';
import type { ChannelRegistryRow, IChannelRegistryRepo } from './channel-registry-types.js';

const COLS = 'name, enabled, is_toggleable, installed_at, installed_by, enabled_at, enabled_by, updated_at';

interface DbChannelRow {
  name: string;
  enabled: boolean;
  is_toggleable: boolean;
  installed_at: string;
  installed_by: string;
  enabled_at: string | null;
  enabled_by: string | null;
  updated_at: string;
}

function mapRow(r: DbChannelRow): ChannelRegistryRow {
  return {
    name: r.name,
    enabled: r.enabled,
    isToggleable: r.is_toggleable,
    installedAt: r.installed_at,
    installedBy: r.installed_by,
    enabledAt: r.enabled_at,
    enabledBy: r.enabled_by,
    updatedAt: r.updated_at,
  };
}

export class ChannelRegistryRepo implements IChannelRegistryRepo {
  constructor(private readonly pool: DbPool) {}

  async listRows(): Promise<ChannelRegistryRow[]> {
    const { rows } = await this.pool.query<DbChannelRow>(`SELECT ${COLS} FROM channel_registry`);
    return rows.map(mapRow);
  }

  async getRow(name: string): Promise<ChannelRegistryRow | null> {
    const { rows } = await this.pool.query<DbChannelRow>(`SELECT ${COLS} FROM channel_registry WHERE name = $1`, [name]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async install(name: string, actor: string, isToggleable: boolean): Promise<ChannelRegistryRow> {
    // Insert a disabled row; if it already exists, leave it untouched (incl. is_toggleable)
    // and return it. The no-op SET makes ON CONFLICT return the existing row via RETURNING.
    const { rows } = await this.pool.query<DbChannelRow>(
      `INSERT INTO channel_registry (name, enabled, is_toggleable, installed_by)
       VALUES ($1, false, $3, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING ${COLS}`,
      [name, actor, isToggleable],
    );
    return mapRow(rows[0]!);
  }

  async enable(name: string, actor: string): Promise<ChannelRegistryRow> {
    const { rows } = await this.pool.query<DbChannelRow>(
      `UPDATE channel_registry
          SET enabled = true, enabled_at = now(), enabled_by = $2, updated_at = now()
        WHERE name = $1
        RETURNING ${COLS}`,
      [name, actor],
    );
    if (!rows[0]) throw new Error(`enable: no channel_registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  // _actor is required by IChannelRegistryRepo for API symmetry with enable(), but
  // disable() clears enabled_by rather than recording who disabled — so the SQL binds
  // only $1 (name). Passing actor as a second param would error: "bind message supplies
  // 2 parameters, but prepared statement requires 1".
  async disable(name: string, _actor: string): Promise<ChannelRegistryRow> {
    const { rows } = await this.pool.query<DbChannelRow>(
      `UPDATE channel_registry
          SET enabled = false, enabled_at = NULL, enabled_by = NULL, updated_at = now()
        WHERE name = $1
        RETURNING ${COLS}`,
      [name],
    );
    if (!rows[0]) throw new Error(`disable: no channel_registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  async uninstall(name: string): Promise<void> {
    await this.pool.query(`DELETE FROM channel_registry WHERE name = $1`, [name]);
  }
}
