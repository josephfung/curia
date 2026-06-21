// src/registry/mcp-registry-repo.ts
// Postgres-backed mcp_server_registry access. Parameterized queries only.
import type { DbPool } from '../db/connection.js';
import type { McpRegistryRow, IMcpRegistryRepo } from './mcp-registry-types.js';

const COLS = 'name, enabled, installed_at, installed_by, enabled_at, enabled_by, updated_at';

interface DbRow {
  name: string;
  enabled: boolean;
  installed_at: string;
  installed_by: string;
  enabled_at: string | null;
  enabled_by: string | null;
  updated_at: string;
}

function mapRow(r: DbRow): McpRegistryRow {
  return {
    name: r.name,
    enabled: r.enabled,
    installedAt: r.installed_at,
    installedBy: r.installed_by,
    enabledAt: r.enabled_at,
    enabledBy: r.enabled_by,
    updatedAt: r.updated_at,
  };
}

export class McpRegistryRepo implements IMcpRegistryRepo {
  constructor(private readonly pool: DbPool) {}

  async listRows(): Promise<McpRegistryRow[]> {
    const { rows } = await this.pool.query<DbRow>(`SELECT ${COLS} FROM mcp_server_registry`);
    return rows.map(mapRow);
  }

  async getRow(name: string): Promise<McpRegistryRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT ${COLS} FROM mcp_server_registry WHERE name = $1`,
      [name],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async install(name: string, actor: string): Promise<McpRegistryRow> {
    const { rows } = await this.pool.query<DbRow>(
      `INSERT INTO mcp_server_registry (name, installed_by)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING ${COLS}`,
      [name, actor],
    );
    return mapRow(rows[0]!);
  }

  async enable(name: string, actor: string): Promise<McpRegistryRow> {
    const { rows } = await this.pool.query<DbRow>(
      `UPDATE mcp_server_registry
          SET enabled = true, enabled_at = now(), enabled_by = $2, updated_at = now()
        WHERE name = $1
        RETURNING ${COLS}`,
      [name, actor],
    );
    if (!rows[0]) throw new Error(`enable: no mcp_server_registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  async disable(name: string, _actor: string): Promise<McpRegistryRow> {
    // Clears enabled_at/enabled_by on disable, same as channel_registry pattern.
    const { rows } = await this.pool.query<DbRow>(
      `UPDATE mcp_server_registry
          SET enabled = false, enabled_at = NULL, enabled_by = NULL, updated_at = now()
        WHERE name = $1
        RETURNING ${COLS}`,
      [name],
    );
    if (!rows[0]) throw new Error(`disable: no mcp_server_registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  async uninstall(name: string): Promise<void> {
    await this.pool.query(`DELETE FROM mcp_server_registry WHERE name = $1`, [name]);
  }
}
