// This file composes the UUID body into larger regexes rather than matching a
// bare id, so it shares the pattern *string* from src/util/uuid.ts rather than
// the isUuid() matcher. Same source of truth either way.
import { UUID_PATTERN } from '../util/uuid.js';

/** Prefix for structured, order-independent dedup-pair tags on review tasks. */
export const DEDUP_PAIR_TAG_PREFIX = 'dedup-pair:';

// The 'i' here is genuinely redundant: UUID_PATTERN spells both hex cases and the
// only other literal in this regex is the ':' separator, so the flag cannot change
// what matches. Kept only because removing it is churn, not because it does work.
//
// It is NOT what makes the 'dedup-pair:' prefix case-insensitive — nothing does.
// extractPairKeyFromTags() gates on tag.startsWith(DEDUP_PAIR_TAG_PREFIX), which is
// case-sensitive, and strips the prefix before this regex ever sees the string.
const CANONICAL_PAIR_KEY_RE = new RegExp(`^(${UUID_PATTERN}):(${UUID_PATTERN})$`, 'i');

// Regex to extract contact IDs from task descriptions filed by contact-find-duplicates
// or the dedup-contacts maintenance script:
//   "Contact A ID: <uuid>  (Display Name)"
//   "Contact B ID: <uuid>  (Display Name)"
//
// Both flags here ARE load-bearing, for different reasons:
//   - 'i' is what accepts label casing other than the exact "Contact A ID:" — e.g.
//     "contact a id:" or "CONTACT B ID:". Dropping it narrows what parses.
//   - 'g' is required by the description.matchAll() call below. Dropping it throws
//     TypeError at runtime rather than narrowing the match.
const CONTACT_ID_LINE_RE = new RegExp(
  `Contact ([AB]) ID: (${UUID_PATTERN})`,
  'gi',
);

/** Canonical (order-independent, lowercase) key for a contact pair. */
export function canonicalPairKey(aId: string, bId: string): string {
  const a = aId.toLowerCase();
  const b = bId.toLowerCase();
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Structured dedup-pair tag stamped on review tasks at creation time. */
export function dedupPairTag(aId: string, bId: string): string {
  return `${DEDUP_PAIR_TAG_PREFIX}${canonicalPairKey(aId, bId)}`;
}

/** Extract a canonical pair key from structured dedup-pair tags. */
export function extractPairKeyFromTags(tags: string[] | null | undefined): string | null {
  if (!tags) return null;
  for (const tag of tags) {
    if (!tag.startsWith(DEDUP_PAIR_TAG_PREFIX)) continue;
    const raw = tag.slice(DEDUP_PAIR_TAG_PREFIX.length);
    const match = raw.match(CANONICAL_PAIR_KEY_RE);
    if (!match) continue;
    return canonicalPairKey(match[1]!, match[2]!);
  }
  return null;
}

/** Extract a canonical pair key from a dedup task description (legacy fallback). */
export function extractPairKeyFromDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const found: Record<string, string> = {};
  for (const match of description.matchAll(CONTACT_ID_LINE_RE)) {
    found[match[1]!.toUpperCase()] = match[2]!.toLowerCase();
  }
  const a = found['A'];
  const b = found['B'];
  if (!a || !b) return null;
  return canonicalPairKey(a, b);
}

/** Resolve a canonical pair key from tags first, then description. */
export function pairKeyFromDedupTask(task: {
  tags?: string[];
  description?: string | null;
}): string | null {
  return extractPairKeyFromTags(task.tags) ?? extractPairKeyFromDescription(task.description);
}
