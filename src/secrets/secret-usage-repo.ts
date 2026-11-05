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
  kind: 'read';
  at: Date;
  /** The agent that ran the skill; null for a system-initiated read. */
  agentId: string | null;
  toolName: string;
  /** Where the value resolved from; null on rows written before the field existed. */
  source: 'vault' | 'env' | null;
  /** Resolved dynamically by reference (ctx.resolveSecretRef) rather than declared. */
  byReference: boolean;
  /** The saved-card field that was filled ('expiry_mm', 'number'); null for a whole-secret read. */
  secretField: string | null;
}

/** The principal's (or the expiry sweep's) decision on a request to pay with a saved card.
 *  Read from card_use.decided rows, so it carries no card number. */
export interface CardUseDecision {
  kind: 'card_use';
  at: Date;
  decision: 'approved' | 'denied' | 'expired';
  siteDomain: string;
  /** The amount as the agent stated it, from the request; null if the request row is gone. */
  amount: string | null;
}

export type SecretUseItem = SecretUse | CardUseDecision;

export interface SecretUsagePort {
  /** Newest secret.accessed timestamp per secret name; a never-read secret is absent. */
  lastUsedByName(): Promise<Map<string, Date>>;
  /** The newest `limit` reads of one secret, and card-use decisions for a saved card, newest first. */
  recentUses(name: string, limit: number, includeCardUses?: boolean): Promise<SecretUseItem[]>;
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

  async recentUses(name: string, limit: number, includeCardUses = false): Promise<SecretUseItem[]> {
    // Two bounded slices (each uses its own index path), merged and cut to `limit` in SQL.
    const result = await this.pool.query<{
      event_type: string;
      timestamp: Date;
      agent_id: string | null;
      tool_name: string | null;
      source: string | null;
      by_reference: string | null;
      secret_field: string | null;
      decision: string | null;
      site_domain: string | null;
      amount: string | null;
    }>(
      `SELECT * FROM (
         (SELECT event_type, timestamp,
                 payload->>'agentId' AS agent_id,
                 payload->>'toolName' AS tool_name,
                 payload->>'source' AS source,
                 payload->>'byReference' AS by_reference,
                 payload->>'secretField' AS secret_field,
                 NULL::text AS decision, NULL::text AS site_domain, NULL::text AS amount
            FROM audit_log
           WHERE event_type = 'secret.accessed' AND payload->>'secretName' = $1
           ORDER BY timestamp DESC
           LIMIT $2)
         UNION ALL
         (SELECT a.event_type, a.timestamp,
                 NULL, NULL, NULL, NULL, NULL,
                 a.payload->>'decision', a.payload->>'siteDomain', r.amount
            FROM audit_log a
            LEFT JOIN card_use_requests r ON r.id::text = a.payload->>'requestId'
           WHERE $3::boolean AND a.event_type = 'card_use.decided' AND a.payload->>'secretName' = $1
           ORDER BY a.timestamp DESC
           LIMIT $2)
       ) uses
       ORDER BY timestamp DESC
       LIMIT $2`,
      [name, limit, includeCardUses],
    );
    const items: SecretUseItem[] = [];
    for (const row of result.rows) {
      if (row.event_type === 'card_use.decided') {
        if (row.decision !== 'approved' && row.decision !== 'denied' && row.decision !== 'expired') continue;
        items.push({
          kind: 'card_use',
          at: row.timestamp,
          decision: row.decision,
          siteDomain: row.site_domain ?? '',
          amount: row.amount,
        });
      } else {
        items.push({
          kind: 'read',
          at: row.timestamp,
          agentId: row.agent_id,
          toolName: row.tool_name ?? '',
          source: row.source === 'vault' || row.source === 'env' ? row.source : null,
          byReference: row.by_reference === 'true',
          secretField: row.secret_field,
        });
      }
    }
    return items;
  }
}
