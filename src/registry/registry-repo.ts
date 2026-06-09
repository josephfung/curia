// registry-repo.ts — Postgres-backed CRUD over skill_registry / agent_registry.
// One instance per table (the table name is validated against an allowlist so it can
// never be attacker-influenced). All queries parameterized. Mirrors the SecretsService
// / AutonomyService injection pattern: constructor takes (pool, table).

import type { DbPool } from '../db/connection.js';
import type { IRegistryRepo, RegistryRow } from './types.js';

// Fixed allowlist — the table name is interpolated into SQL (identifiers can't be
// parameterized), so it MUST come from this set and never from user input.
const ALLOWED_TABLES = new Set(['skill_registry', 'agent_registry']);

interface DbRegistryRow {
  name: string;
  enabled: boolean;
  installed_at: string;
  installed_by: string;
  enabled_at: string | null;
  enabled_by: string | null;
  updated_at: string;
}

function mapRow(row: DbRegistryRow): RegistryRow {
  return {
    name: row.name,
    enabled: row.enabled,
    installedAt: row.installed_at,
    installedBy: row.installed_by,
    enabledAt: row.enabled_at,
    enabledBy: row.enabled_by,
    updatedAt: row.updated_at,
  };
}

const COLS = 'name, enabled, installed_at, installed_by, enabled_at, enabled_by, updated_at';

export class RegistryRepo implements IRegistryRepo {
  private readonly table: string;

  constructor(private readonly pool: DbPool, table: string) {
    if (!ALLOWED_TABLES.has(table)) {
      throw new Error(`RegistryRepo: invalid table '${table}'`);
    }
    this.table = table;
  }

  async listRows(): Promise<RegistryRow[]> {
    const { rows } = await this.pool.query<DbRegistryRow>(`SELECT ${COLS} FROM ${this.table}`);
    return rows.map(mapRow);
  }

  async getRow(name: string): Promise<RegistryRow | null> {
    const { rows } = await this.pool.query<DbRegistryRow>(
      `SELECT ${COLS} FROM ${this.table} WHERE name = $1`, [name],
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async install(name: string, actor: string): Promise<RegistryRow> {
    // Insert a disabled row; if it already exists, leave it untouched and return it.
    // ON CONFLICT DO UPDATE requires at least one SET clause, so we use a no-op
    // (name = EXCLUDED.name) to trigger RETURNING without modifying any columns.
    const { rows } = await this.pool.query<DbRegistryRow>(
      `INSERT INTO ${this.table} (name, enabled, installed_by)
       VALUES ($1, false, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING ${COLS}`,
      [name, actor],
    );
    return mapRow(rows[0]!);
  }

  async enable(name: string, actor: string): Promise<RegistryRow> {
    const { rows } = await this.pool.query<DbRegistryRow>(
      `UPDATE ${this.table}
         SET enabled = true, enabled_at = now(), enabled_by = $2, updated_at = now()
       WHERE name = $1
       RETURNING ${COLS}`,
      [name, actor],
    );
    if (!rows[0]) throw new Error(`enable: no registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  // _actor is required by IRegistryRepo for API consistency (audit trails may
  // use it in a future implementation), but clearing enabled_at/by is the
  // canonical way to record a disable — no separate actor column needed now.
  async disable(name: string, _actor: string): Promise<RegistryRow> {
    const { rows } = await this.pool.query<DbRegistryRow>(
      `UPDATE ${this.table}
         SET enabled = false, enabled_at = NULL, enabled_by = NULL, updated_at = now()
       WHERE name = $1
       RETURNING ${COLS}`,
      [name],
    );
    if (!rows[0]) throw new Error(`disable: no registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  async uninstall(name: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.table} WHERE name = $1`, [name]);
  }
}
