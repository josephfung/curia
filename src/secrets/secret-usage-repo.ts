/**
 * SecretUsageRepo — per-secret usage read from the audit log.
 *
 * Every ctx.secret() / ctx.resolveSecretRef() call publishes a secret.accessed event, so the
 * audit_log is the record of when a secret was read and by whom. This repo only reads it, via
 * idx_audit_log_secret_accessed (migration 118). Names and metadata only — a value is never in
 * the payload. "Used" means Curia read the secret; whether the sign-in worked isn't recorded.
 */

import type { DbPool } from '../db/connection.js';

export interface SecretUse {
  at: Date;
  /** The agent that ran the skill; null for a system-initiated read. */
  agentId: string | null;
  toolName: string;
  /** Where the value resolved from; null on rows written before the field existed. */
  source: 'vault' | 'env' | null;
  /** Resolved dynamically by reference (ctx.resolveSecretRef) rather than declared. */
  byReference: boolean;
}

export interface SecretUsagePort {
  /** Newest secret.accessed timestamp for each of `names`; a never-read secret is absent. */
  lastUsedByName(names: readonly string[]): Promise<Map<string, Date>>;
  /** The newest `limit` reads of one secret, newest first. */
  recentUses(name: string, limit: number): Promise<SecretUse[]>;
}

export class SecretUsageRepo implements SecretUsagePort {
  constructor(private readonly pool: DbPool) {}

  // One index lookup per listed name (the newest entry of idx_audit_log_secret_accessed for
  // it), not a group over every secret.accessed row: audit_log is append-only, so that would
  // grow with the log. The cost follows the number of secrets the page lists.
  async lastUsedByName(names: readonly string[]): Promise<Map<string, Date>> {
    if (names.length === 0) return new Map();
    const result = await this.pool.query<{ name: string; last_used: Date | null }>(
      `SELECT n.name,
              (SELECT a.timestamp FROM audit_log a
                WHERE a.event_type = 'secret.accessed' AND a.payload->>'secretName' = n.name
                ORDER BY a.timestamp DESC
                LIMIT 1) AS last_used
         FROM unnest($1::text[]) AS n(name)`,
      [names],
    );
    const byName = new Map<string, Date>();
    for (const row of result.rows) {
      if (row.name && row.last_used) byName.set(row.name, row.last_used);
    }
    return byName;
  }

  async recentUses(name: string, limit: number): Promise<SecretUse[]> {
    const result = await this.pool.query<{
      timestamp: Date;
      agent_id: string | null;
      tool_name: string | null;
      source: string | null;
      by_reference: string | null;
    }>(
      `SELECT timestamp,
              payload->>'agentId' AS agent_id,
              payload->>'toolName' AS tool_name,
              payload->>'source' AS source,
              payload->>'byReference' AS by_reference
         FROM audit_log
        WHERE event_type = 'secret.accessed' AND payload->>'secretName' = $1
        ORDER BY timestamp DESC, seq DESC NULLS LAST
        LIMIT $2`,
      [name, limit],
    );
    return result.rows.map((row) => ({
      at: row.timestamp,
      agentId: row.agent_id,
      toolName: row.tool_name ?? '',
      source: row.source === 'vault' || row.source === 'env' ? row.source : null,
      byReference: row.by_reference === 'true',
    }));
  }
}
