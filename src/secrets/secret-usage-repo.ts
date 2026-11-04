/**
 * SecretUsageRepo — per-secret usage read from the audit log.
 *
 * Every ctx.secret() / ctx.resolveSecretRef() call publishes a secret.accessed event, so the
 * audit_log is the record of when a secret was read and by whom. This repo only reads it, via
 * idx_audit_log_secret_accessed (migration 117). Names and metadata only — a value is never in
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
  /** Newest secret.accessed timestamp per secret name; a never-read secret is absent. */
  lastUsedByName(): Promise<Map<string, Date>>;
  /** The newest `limit` reads of one secret, newest first. */
  recentUses(name: string, limit: number): Promise<SecretUse[]>;
}

export class SecretUsageRepo implements SecretUsagePort {
  constructor(private readonly pool: DbPool) {}

  async lastUsedByName(): Promise<Map<string, Date>> {
    const result = await this.pool.query<{ name: string; last_used: Date }>(
      `SELECT payload->>'secretName' AS name, max(timestamp) AS last_used
         FROM audit_log
        WHERE event_type = 'secret.accessed'
        GROUP BY 1`,
    );
    const byName = new Map<string, Date>();
    for (const row of result.rows) {
      if (row.name) byName.set(row.name, row.last_used);
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
        ORDER BY timestamp DESC
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
