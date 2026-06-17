// src/contacts/dedup-classifier.ts
//
// Classifies a contact pair as either 'structural' (eligible for auto-merge)
// or 'fuzzy' (eligible for a recommendation task only).
//
// Structural proof — any ONE of:
//   (a) Two contacts share a verified channel identity (same channel + identifier).
//   (b) Same non-null kg_node_id.
//   (c) Exact normalized alias/label match (normalized display names are identical).
//
// Fuzzy — no structural proof, but above the DedupService scoring threshold.
//   Name similarity (Jaro-Winkler) and embedding similarity are fuzzy signals.
//   No matter how high the score, they never auto-merge. This deliberately overrides
//   the old DedupService behaviour where score ≥ 0.9 was labelled 'certain'.
//
// Returns null when the pair is below the scoring threshold (nothing to act on).
//
// The classifier is pure and sync where possible — it delegates to DedupService
// for the underlying JW scoring, but adds the structural classification layer on top.

import type { Contact, ChannelIdentity } from './types.js';
import { DedupService } from './dedup-service.js';

// Singleton scorer — stateless, safe to share
const dedupService = new DedupService();

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type PairClassification =
  | {
      type: 'structural';
      /** Human-readable description of the structural proof (for logging/reporting). */
      reason: string;
    }
  | {
      type: 'fuzzy';
      /** JW score (0–1) from the underlying scorer. */
      score: number;
      /** Human-readable description from DedupService (for task description). */
      reason: string;
    };

// ---------------------------------------------------------------------------
// Name normalization (must match DedupService.normalizeDisplayName exactly)
// ---------------------------------------------------------------------------

function normalizeDisplayName(name: string): string {
  return name
    .normalize('NFKD')              // decompose accents: "é" → "e" + combining mark
    .replace(/\p{M}/gu, '')         // strip the combining marks (diacritics)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '') // keep Unicode letters/numbers + spaces (preserves CJK/Arabic)
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Identity key canonicalization (must match DedupService exactly)
// ---------------------------------------------------------------------------

function canonicalIdentityKey(channel: string, identifier: string): string {
  // Emails are matched case-insensitively (migration 044's LOWER() unique index),
  // so lowercase them before comparison; phone/signal are already normalized at write.
  // Without this, mixed-case email identities for the same address fail structural proof.
  const id = channel === 'email' ? identifier.toLowerCase() : identifier;
  return `${channel}:${id}`;
}

// ---------------------------------------------------------------------------
// classifyPair
// ---------------------------------------------------------------------------

/**
 * Classify a contact pair as structural or fuzzy.
 *
 * Returns null when the pair is below the minimum scoring threshold —
 * the caller should skip such pairs entirely.
 *
 * @param a - first contact
 * @param aIdentities - channel identities for a
 * @param b - second contact
 * @param bIdentities - channel identities for b
 */
export function classifyPair(
  a: Contact,
  aIdentities: ChannelIdentity[],
  b: Contact,
  bIdentities: ChannelIdentity[],
): PairClassification | null {
  // Self-comparison is never a valid pair
  if (a.id === b.id) return null;

  // ------------------------------------------------------------------
  // Structural proof (a): shared VERIFIED channel identity
  // ------------------------------------------------------------------
  // Build a set of "<channel>:<identifier>" keys for contact a's VERIFIED
  // identities only. An unverified shared identity is not structural proof —
  // it falls through to the fuzzy path (recommendation, not auto-merge).
  // This is O(|aIds| + |bIds|).
  const aIdKeys = new Set(
    aIdentities.filter(i => i.verified).map(i => canonicalIdentityKey(i.channel, i.channelIdentifier)),
  );
  for (const bId of bIdentities) {
    // Both sides must be verified: a's key was built from verified-only identities,
    // and we check bId.verified here before looking up the key.
    if (!bId.verified) continue;
    const key = canonicalIdentityKey(bId.channel, bId.channelIdentifier);
    if (aIdKeys.has(key)) {
      return {
        type: 'structural',
        reason: `Same ${bId.channel} identifier`,
      };
    }
  }

  // ------------------------------------------------------------------
  // Structural proof (b): same non-null kg_node_id
  // ------------------------------------------------------------------
  // Both contacts referencing the same KG node means they are already
  // identified as the same real-world entity in the knowledge graph.
  if (a.kgNodeId !== null && b.kgNodeId !== null && a.kgNodeId === b.kgNodeId) {
    return {
      type: 'structural',
      reason: `Same kg_node_id: ${a.kgNodeId}`,
    };
  }

  // ------------------------------------------------------------------
  // Structural proof (c): exact normalized name match
  // ------------------------------------------------------------------
  // If the normalized display names are identical (after lowercasing and stripping
  // punctuation), this is considered structural proof — the contacts refer to the
  // same entity under different casing or minor formatting. This is the most
  // conservative form of the name signal; JW similarity is always fuzzy.
  //
  // For person contacts, single-token names (e.g. "Smith") are NOT sufficient:
  // a single first name or last name is too ambiguous. We require at least 2
  // whitespace-separated tokens AND length ≥ 5 to guard against false positives.
  //
  // For organization and automated contacts, an exact single-token name is a
  // much stronger signal — a brand or sender name is far less ambiguous than a
  // personal first name. When both contacts are organization/automated, structural
  // proof is granted on a single-token exact match (still requiring length ≥ 5 to
  // exclude very short abbreviations). See issue #1035.
  const normalA = normalizeDisplayName(a.displayName);
  const normalB = normalizeDisplayName(b.displayName);
  if (normalA.length >= 5 && normalA === normalB) {
    // 'principal' and 'agent' kinds are intentionally excluded: the principal
    // is never auto-merged by the dedup rules, and agent contacts (Curia itself)
    // don't benefit from single-token name merging.
    const bothOrgKinds =
      (a.kind === 'organization' || a.kind === 'automated') &&
      (b.kind === 'organization' || b.kind === 'automated');
    const hasMultipleTokens = normalA.split(' ').length >= 2;
    if (bothOrgKinds || hasMultipleTokens) {
      // Include path in reason to distinguish org single-token from multi-token in audit logs.
      const reason = bothOrgKinds && !hasMultipleTokens
        ? `Exact normalized name match (single-token org/automated): "${normalA}"`
        : `Exact normalized name match: "${normalA}"`;
      return { type: 'structural', reason };
    }
  }

  // ------------------------------------------------------------------
  // Fuzzy: delegate to DedupService for JW scoring
  // ------------------------------------------------------------------
  // Any match returned here is fuzzy — name similarity never proves identity.
  // Use checkForDuplicates with a single-item candidate list as a thin adapter
  // to the existing scoring logic, then re-interpret the result.
  // Direct pair scoring — NOT checkForDuplicates, which applies name-blocking and
  // would drop genuinely-similar pairs whose blocking keys differ (returning null
  // instead of a fuzzy match/task). The caller iterates explicit pairs, so we score
  // this pair directly with no blocking.
  const pair = dedupService.scorePair(a, aIdentities, b, bIdentities);
  if (pair === null) return null;

  // Any non-structural match is fuzzy — name similarity never proves identity.
  // scorePair may return 1.0 for an UNVERIFIED shared identity; that is intentionally
  // a fuzzy recommendation here, never an auto-merge.
  return {
    type: 'fuzzy',
    score: pair.score,
    reason: pair.reason,
  };
}
