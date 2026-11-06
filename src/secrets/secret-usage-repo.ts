/**
 * SecretUsageRepo — per-secret usage read from the audit log.
 *
 * Every ctx.secret() / ctx.resolveSecretRef() call publishes a secret.accessed event, so the
 * audit_log is the record of when a secret was read and by whom. This repo only reads it, via
 * idx_audit_log_secret_accessed (migration 118). Names and metadata only — a value is never in
 * the payload. "Used" means Curia read the secret; whether the sign-in worked isn't recorded.
 */

import type { DbPool } from '../db/connection.js';
import { UUID_PATTERN } from '../util/uuid.js';

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
  /** 'failed': the principal approved but the replay failed before a grant was written. */
  decision: 'approved' | 'denied' | 'expired' | 'failed';
  siteDomain: string;
  /** The amount as the agent stated it, from the request; null if the request row is gone. */
  amount: string | null;
}

export type SecretUseItem = SecretUse | CardUseDecision;

export interface SecretUsagePort {
  /** Newest secret.accessed timestamp for each of `names`; a never-read secret is absent. */
  lastUsedByName(names: readonly string[]): Promise<Map<string, Date>>;
  /** The newest `limit` reads of one secret, and card-use decisions for a saved card, newest first. */
  recentUses(name: string, limit: number, includeCardUses?: boolean): Promise<SecretUseItem[]>;
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
         (SELECT event_type, timestamp, seq,
                 payload->>'agentId' AS agent_id,
                 payload->>'toolName' AS tool_name,
                 payload->>'source' AS source,
                 payload->>'byReference' AS by_reference,
                 payload->>'secretField' AS secret_field,
                 NULL::text AS decision, NULL::text AS site_domain, NULL::text AS amount
            FROM audit_log
           WHERE event_type = 'secret.accessed' AND payload->>'secretName' = $1
           ORDER BY timestamp DESC, seq DESC NULLS LAST
           LIMIT $2)
         UNION ALL
         (SELECT a.event_type, a.timestamp, a.seq,
                 NULL, NULL, NULL, NULL, NULL,
                 a.payload->>'decision', a.payload->>'siteDomain', r.amount
            FROM audit_log a
            -- Join on the UUID so the primary key is used; the CASE keeps a missing or malformed
            -- id from failing the cast and keeps its row (with no amount).
            LEFT JOIN card_use_requests r ON r.id = CASE
              WHEN a.payload->>'requestId' ~* '^' || $4::text || '$'
              THEN (a.payload->>'requestId')::uuid END
           WHERE $3::boolean AND a.event_type = 'card_use.decided' AND a.payload->>'secretName' = $1
           ORDER BY a.timestamp DESC, a.seq DESC NULLS LAST
           LIMIT $2)
       ) uses
       ORDER BY timestamp DESC, seq DESC NULLS LAST
       LIMIT $2`,
      [name, limit, includeCardUses, UUID_PATTERN],
    );
    const items: SecretUseItem[] = [];
    for (const row of result.rows) {
      if (row.event_type === 'card_use.decided') {
        if (row.decision !== 'approved' && row.decision !== 'denied' && row.decision !== 'expired' && row.decision !== 'failed') continue;
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
