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
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
  // Structural proof (a): shared channel identity
  // ------------------------------------------------------------------
  // Build a set of "<channel>:<identifier>" keys for contact a, then check
  // whether any of contact b's identities match. This is O(|aIds| + |bIds|).
  const aIdKeys = new Set(aIdentities.map(i => `${i.channel}:${i.channelIdentifier}`));
  for (const bId of bIdentities) {
    const key = `${bId.channel}:${bId.channelIdentifier}`;
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
  // same person under different casing or minor formatting. This is the most
  // conservative form of the name signal; JW similarity is always fuzzy.
  const normalA = normalizeDisplayName(a.displayName);
  const normalB = normalizeDisplayName(b.displayName);
  if (normalA.length > 0 && normalA === normalB) {
    return {
      type: 'structural',
      reason: `Exact normalized name match: "${normalA}"`,
    };
  }

  // ------------------------------------------------------------------
  // Fuzzy: delegate to DedupService for JW scoring
  // ------------------------------------------------------------------
  // Any match returned here is fuzzy — name similarity never proves identity.
  // Use checkForDuplicates with a single-item candidate list as a thin adapter
  // to the existing scoring logic, then re-interpret the result.
  const pairs = dedupService.checkForDuplicates(
    a,
    aIdentities,
    [b],
    new Map([[b.id, bIdentities]]),
  );

  if (pairs.length === 0) return null;

  const pair = pairs[0]!;
  // The DedupService may still return 'certain' for channel overlap (already handled
  // above) or for high JW. Under the new design, any non-structural match is fuzzy.
  return {
    type: 'fuzzy',
    score: pair.score,
    reason: pair.reason,
  };
}
