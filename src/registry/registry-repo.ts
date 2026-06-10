// registry-repo.ts — Postgres-backed CRUD over skill_registry / agent_registry.
// One instance per table (the table name is validated against an allowlist so it can
// never be attacker-influenced). All queries parameterized. Mirrors the SecretsService
// / AutonomyService injection pattern: constructor takes (pool, table).

import type { DbPool } from '../db/connection.js';
import type { IRegistryRepo, RegistryRow } from './types.js';

// Only these two tables are valid — validated in the constructor.
// SQL strings use literal table names (never runtime concatenation) so the
// parameterized-queries rule is satisfied: data values use $1/$2, table names
// are compile-time string literals selected via this map.
const ALLOWED_TABLES = ['skill_registry', 'agent_registry'] as const;
type RegistryTable = typeof ALLOWED_TABLES[number];

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

// Prebuilt SQL per table — no runtime string interpolation of identifiers.
const SQL: Record<RegistryTable, {
  list: string;
  get: string;
  install: string;
  enable: string;
  disable: string;
  uninstall: string;
}> = {
  skill_registry: {
    list: `SELECT ${COLS} FROM skill_registry`,
    get: `SELECT ${COLS} FROM skill_registry WHERE name = $1`,
    install: `INSERT INTO skill_registry (name, enabled, installed_by)
              VALUES ($1, false, $2)
              ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
              RETURNING ${COLS}`,
    enable: `UPDATE skill_registry
               SET enabled = true, enabled_at = now(), enabled_by = $2, updated_at = now()
             WHERE name = $1
             RETURNING ${COLS}`,
    disable: `UPDATE skill_registry
                SET enabled = false, enabled_at = NULL, enabled_by = NULL, updated_at = now()
              WHERE name = $1
              RETURNING ${COLS}`,
    uninstall: `DELETE FROM skill_registry WHERE name = $1`,
  },
  agent_registry: {
    list: `SELECT ${COLS} FROM agent_registry`,
    get: `SELECT ${COLS} FROM agent_registry WHERE name = $1`,
    install: `INSERT INTO agent_registry (name, enabled, installed_by)
              VALUES ($1, false, $2)
              ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
              RETURNING ${COLS}`,
    enable: `UPDATE agent_registry
               SET enabled = true, enabled_at = now(), enabled_by = $2, updated_at = now()
             WHERE name = $1
             RETURNING ${COLS}`,
    disable: `UPDATE agent_registry
                SET enabled = false, enabled_at = NULL, enabled_by = NULL, updated_at = now()
              WHERE name = $1
              RETURNING ${COLS}`,
    uninstall: `DELETE FROM agent_registry WHERE name = $1`,
  },
};

export class RegistryRepo implements IRegistryRepo {
  private readonly sql: typeof SQL[RegistryTable];

  constructor(private readonly pool: DbPool, table: string) {
    if (!(ALLOWED_TABLES as readonly string[]).includes(table)) {
      throw new Error(`RegistryRepo: invalid table '${table}'`);
    }
    this.sql = SQL[table as RegistryTable];
  }

  async listRows(): Promise<RegistryRow[]> {
    const { rows } = await this.pool.query<DbRegistryRow>(this.sql.list);
    return rows.map(mapRow);
  }

  async getRow(name: string): Promise<RegistryRow | null> {
    const { rows } = await this.pool.query<DbRegistryRow>(this.sql.get, [name]);
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async install(name: string, actor: string): Promise<RegistryRow> {
    // Insert a disabled row; if it already exists, leave it untouched and return it.
    // ON CONFLICT DO UPDATE requires at least one SET clause, so we use a no-op
    // (name = EXCLUDED.name) to trigger RETURNING without modifying any columns.
    const { rows } = await this.pool.query<DbRegistryRow>(this.sql.install, [name, actor]);
    return mapRow(rows[0]!);
  }

  async enable(name: string, actor: string): Promise<RegistryRow> {
    const { rows } = await this.pool.query<DbRegistryRow>(this.sql.enable, [name, actor]);
    if (!rows[0]) throw new Error(`enable: no registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  // _actor is required by IRegistryRepo for API consistency (audit trails may
  // use it in a future implementation), but clearing enabled_at/by is the
  // canonical way to record a disable — no separate actor column needed now.
  async disable(name: string, _actor: string): Promise<RegistryRow> {
    const { rows } = await this.pool.query<DbRegistryRow>(this.sql.disable, [name]);
    if (!rows[0]) throw new Error(`disable: no registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  async uninstall(name: string): Promise<void> {
    await this.pool.query(this.sql.uninstall, [name]);
  }
}
