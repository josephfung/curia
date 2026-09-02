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

/** The first external originator of a conversation, as far as the audit trail records it. */
export interface FirstExternalOriginator {
  /** Contact tier at task initiation. Null for rows stamped before #950. */
  tier: ContactTier | null;
  /** Contact id of that originator. Null when the audit row predates the field. */
  contactId: string | null;
}

/**
 * Load the first external contact who originated an agent.task in this conversation.
 * Returns 'none' when every task is principal/system/agent-originated.
 *
 * Spec 10 maps every `agent.task` row's structured initiator to `system`/`dispatch`
 * (originator detail stays in `payload.metadata.originator`). So this query always
 * uses the payload path for Phase 1 + pre-hardening rows — there is no structured
 * `initiator_type = 'human'` shortcut for agent.task. Uses idx_audit_conversation.
 *
 * `contactId` is read for a second purpose beyond the trust gate: it is the
 * conversation's counterpart, and checkpoint extraction passes it to extract-facts as
 * a tiebreaker for ambiguous subject names (#1694). Both consumers come from this one
 * row, so there is no extra query.
 */
export async function loadFirstExternalOriginator(
  pool: DbPool,
  conversationId: string,
): Promise<FirstExternalOriginator | NoExternalOriginator> {
  const result = await pool.query<{ tier: string | null; contact_id: string | null }>(
    `SELECT payload->'metadata'->'originator'->>'tier'      AS tier,
            payload->'metadata'->'originator'->>'contactId' AS contact_id
     FROM audit_log
     WHERE conversation_id = $1
       AND event_type = 'agent.task'
       AND payload->'metadata'->'originator' IS NOT NULL
       AND jsonb_typeof(payload->'metadata'->'originator') = 'object'
       AND (
         payload->'metadata'->'originator'->>'systemRole' IS NULL
         OR payload->'metadata'->'originator'->>'systemRole' NOT IN ('principal', 'system', 'agent')
       )
     ORDER BY timestamp ASC
     LIMIT 1`,
    [conversationId],
  );

  const row = result.rows[0];
  if (!row) return 'none';
  return {
    tier: (row.tier as ContactTier | null) ?? null,
    contactId: row.contact_id ?? null,
  };
}

/**
 * Tier-only view of {@link loadFirstExternalOriginator}, kept as the shape the trust
 * gate reasons about.
 */
export async function loadFirstExternalOriginatorTier(
  pool: DbPool,
  conversationId: string,
): Promise<ContactTier | null | NoExternalOriginator> {
  const originator = await loadFirstExternalOriginator(pool, conversationId);
  return originator === 'none' ? 'none' : originator.tier;
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
