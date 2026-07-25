// hash-chain.ts — SHA-256 hash chain for audit_log tamper evidence (spec 10).
//
// entry_hash = SHA-256(canonical_json(fields) + previous_entry_hash)
// First row chains from GENESIS_HASH = SHA-256("curia-audit-genesis-v1").

import { createHash } from 'node:crypto';

/** Fixed genesis constant — first audit row chains from this value. */
export const AUDIT_GENESIS_SEED = 'curia-audit-genesis-v1';

export const GENESIS_HASH = createHash('sha256').update(AUDIT_GENESIS_SEED).digest('hex');

/** Fields hashed into each entry (excludes entry_hash itself and acknowledged). */
export interface HashChainFields {
  id: string;
  timestamp: string; // ISO-8601
  event_type: string;
  source_layer: string;
  source_id: string;
  payload: unknown;
  conversation_id: string | null;
  task_id: string | null;
  parent_event_id: string | null;
  action: string | null;
  outcome: string | null;
  target_type: string | null;
  target_id: string | null;
  initiator_type: string | null;
  initiator_id: string | null;
}

/**
 * Deterministic JSON: object keys sorted alphabetically at every level, no
 * whitespace. Arrays keep order.
 *
 * Round-trips through JSON.stringify/parse first so Date/Buffer/toJSON values
 * collapse exactly the way the persisted JSONB column will — otherwise
 * write-time hashes (which may see live Date objects from stripNullBytes) and
 * verify-time hashes (which see ISO strings from jsonb) diverge.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value)) as unknown));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

/** Compute entry_hash for the given fields chained from previousEntryHash. */
export function computeEntryHash(fields: HashChainFields, previousEntryHash: string): string {
  return createHash('sha256')
    .update(canonicalJson(fields) + previousEntryHash)
    .digest('hex');
}

/** Normalize a Date (or Date-like) to the ISO string used in the hash input. */
export function toHashTimestamp(timestamp: Date | string): string {
  if (timestamp instanceof Date) {
    return timestamp.toISOString();
  }
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid audit timestamp for hash chain: ${String(timestamp)}`);
  }
  return d.toISOString();
}
