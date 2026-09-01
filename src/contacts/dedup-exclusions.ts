// Contact dedup exclusions — ordered-pair normalization.
//
// An exclusion records a decision ("the CEO ruled these two contacts are not the
// same person"), which lives in the relational ledger, not the knowledge graph.
// It is persisted as one row per unordered pair in contact_dedup_exclusions,
// under CHECK (contact_a_id < contact_b_id). See ADR-039 for why exclusions moved
// off KG fact nodes (#1625).
//
// This module is the single normalization chokepoint: every read and write of an
// exclusion goes through normalizeExclusionPair() so a pair passed in either order
// or either casing always resolves to the same row.

/** A contact pair in canonical stored order: contactAId < contactBId, both lowercase. */
export interface ExclusionPair {
  contactAId: string;
  contactBId: string;
}

/** Thrown when a pair cannot be normalized into a storable exclusion row. */
export class InvalidExclusionPairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExclusionPairError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalize a contact pair into the canonical order the table stores.
 *
 * Lowercases both IDs (callers accept uppercase UUIDs; Postgres always returns
 * lowercase) and sorts them ascending so a pair is one row, not two.
 *
 * Throws InvalidExclusionPairError when either ID is not a UUID, or when both
 * sides are the same contact — either would otherwise be rejected by the table's
 * FK / CHECK constraints as an opaque database error at write time, and would
 * silently match nothing at read time.
 */
export function normalizeExclusionPair(aId: string, bId: string): ExclusionPair {
  if (!UUID_RE.test(aId)) {
    throw new InvalidExclusionPairError(`contact id is not a valid UUID: "${aId}"`);
  }
  if (!UUID_RE.test(bId)) {
    throw new InvalidExclusionPairError(`contact id is not a valid UUID: "${bId}"`);
  }

  const a = aId.toLowerCase();
  const b = bId.toLowerCase();

  if (a === b) {
    throw new InvalidExclusionPairError(`a contact cannot be excluded against itself: ${a}`);
  }

  return a < b ? { contactAId: a, contactBId: b } : { contactAId: b, contactBId: a };
}
