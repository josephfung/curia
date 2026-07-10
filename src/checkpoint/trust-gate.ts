// trust-gate.ts — checkpoint KG extraction trust policy (#1290).
//
// Before running extract-facts / extract-relationships at conversation checkpoint,
// load the first external originator tier from the audit trail. On low-trust channels,
// skip extraction when that tier is unknown or blocked so unsolicited email cannot
// poison the knowledge graph after the coordinator turn ends.

import type { DbPool } from '../db/connection.js';
import type {
  ChannelPolicyConfig,
  ContactTier,
  TaskOriginator,
  TrustLevel,
} from '../contacts/types.js';

const INTERNAL_SYSTEM_ROLES = new Set(['principal', 'system', 'agent']);

/** True when the originator represents an external contact, not platform-internal lineage. */
export function isExternalContactOriginator(originator: TaskOriginator): boolean {
  if (originator.systemRole != null && INTERNAL_SYSTEM_ROLES.has(originator.systemRole)) {
    return false;
  }
  return true;
}

/** Sentinel returned when no external originator appears in the conversation audit trail. */
export type NoExternalOriginator = 'none';

/**
 * Load the tier of the first external contact who originated an agent.task in this
 * conversation. Returns 'none' when every task is principal/system/agent-originated.
 */
export async function loadFirstExternalOriginatorTier(
  pool: DbPool,
  conversationId: string,
): Promise<ContactTier | null | NoExternalOriginator> {
  const result = await pool.query<{ originator: unknown }>(
    `SELECT payload->'metadata'->'originator' AS originator
     FROM audit_log
     WHERE conversation_id = $1
       AND event_type = 'agent.task'
     ORDER BY timestamp ASC`,
    [conversationId],
  );

  for (const row of result.rows) {
    const raw = row.originator;
    if (!raw || typeof raw !== 'object') continue;
    const originator = raw as TaskOriginator;
    if (!isExternalContactOriginator(originator)) continue;
    return originator.tier ?? null;
  }

  return 'none';
}

export function resolveChannelTrust(
  channelId: string,
  channelPolicies?: Record<string, ChannelPolicyConfig>,
): TrustLevel {
  return channelPolicies?.[channelId]?.trust ?? 'low';
}

/**
 * Whether checkpoint extract-facts / extract-relationships should be skipped for this
 * conversation. Low-trust channels (email default) block when the first external
 * originator is unknown, blocked, or carries no resolved tier (fail closed).
 */
export function shouldSkipCheckpointKgExtraction(
  channelTrust: TrustLevel,
  firstExternalTier: ContactTier | null | NoExternalOriginator,
): boolean {
  if (channelTrust !== 'low') return false;
  if (firstExternalTier === 'none') return false;
  if (firstExternalTier === null) return true;
  return firstExternalTier === 'unknown' || firstExternalTier === 'blocked';
}
