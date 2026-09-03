// bundle-cascade-repo.ts — atomic enable/disable of a skill bundle together with its
// member tools. RegistryRepo is one-instance-per-table by design; a bundle cascade
// spans skill_registry and tool_registry, so it lives here and owns its transaction.
//
// A half-applied cascade is worse than the current state: it would leave a bundle
// enabled with some members off, which is exactly the partial state the UI is meant
// to make impossible. Hence BEGIN/COMMIT with an explicit ROLLBACK on any failure.

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { IBundleCascadeRepo } from './types.js';

// Upsert-then-enable in one statement. ON CONFLICT covers the case where the row
// already exists (installed but disabled) — the common path for a bundle that shipped
// disabled. Table names are compile-time literals; all values are parameterized.
const ENABLE_SKILL = `
  INSERT INTO skill_registry (name, enabled, installed_by, enabled_at, enabled_by)
  VALUES ($1, true, $2, now(), $2)
  ON CONFLICT (name) DO UPDATE
    SET enabled = true, enabled_at = now(), enabled_by = $2`;

const ENABLE_TOOL = `
  INSERT INTO tool_registry (name, enabled, installed_by, enabled_at, enabled_by)
  VALUES ($1, true, $2, now(), $2)
  ON CONFLICT (name) DO UPDATE
    SET enabled = true, enabled_at = now(), enabled_by = $2`;

const DISABLE_SKILL = `
  UPDATE skill_registry SET enabled = false, enabled_at = NULL, enabled_by = NULL
  WHERE name = $1`;

const DISABLE_TOOL = `
  UPDATE tool_registry SET enabled = false, enabled_at = NULL, enabled_by = NULL
  WHERE name = $1`;

export class BundleCascadeRepo implements IBundleCascadeRepo {
  constructor(private readonly pool: DbPool, private readonly logger: Logger) {}

  async enableBundle(bundle: string, tools: string[], actor: string): Promise<void> {
    await this.run('enable', bundle, tools, actor, ENABLE_SKILL, ENABLE_TOOL);
  }

  async disableBundle(bundle: string, tools: string[], actor: string): Promise<void> {
    await this.run('disable', bundle, tools, actor, DISABLE_SKILL, DISABLE_TOOL);
  }

  private async run(
    op: 'enable' | 'disable',
    bundle: string,
    tools: string[],
    actor: string,
    bundleSql: string,
    toolSql: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Disable takes only the name; enable also records the actor.
      await client.query(bundleSql, op === 'enable' ? [bundle, actor] : [bundle]);
      for (const tool of tools) {
        await client.query(toolSql, op === 'enable' ? [tool, actor] : [tool]);
      }
      await client.query('COMMIT');
    } catch (err) {
      this.logger.error({ err, bundle, tools, op }, `Bundle ${op} cascade failed; rolling back`);
      // Guard the ROLLBACK itself — if the connection dropped it may throw, and that
      // must not mask the original error.
      await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
        this.logger.error({ rollbackErr, bundle, op }, 'ROLLBACK failed after cascade error');
      });
      throw err;
    } finally {
      client.release();
    }
  }
}
