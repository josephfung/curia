// src/contacts/confidence-scorer.ts
//
// Pure contact confidence scoring formula. No I/O — takes pre-fetched contact
// stats and identity data, returns a float in [0.0, 1.0].
//
// Both the incremental and full-recompute paths call this function. Convergence
// is guaranteed because both paths use the same stored columns as inputs.

import { meetsMinimumTier, type ContactTier } from './types.js';

// -- Tunable constants (exported for tests and documentation) --

/** Messages beyond this count produce no additional interaction score. */
export const SATURATION = 20;

/** Weight of the interaction (message volume) component. Max contribution: 0.35. */
export const W_INTERACTION = 0.35;

/** Weight of the recency component. Max contribution: 0.20. */
export const W_RECENCY = 0.20;

/** Half-life for recency decay in days. Score halves every 90 days of silence. */
export const RECENCY_HALF_LIFE_DAYS = 90;

/** Confidence boost when the contact is at trusted or principal tier. */
export const GRANT_BOOST = 0.25;

/** Confidence boost when the contact was manually created by the CEO (ceo_stated identity). */
export const MANUAL_BOOST = 0.10;

/** Max confidence boost from verified identity pairings. Capped at 3 identities. */
export const PAIRING_BOOST = 0.10;

/** Minimum contact_confidence to trigger automatic tier elevation from 'unknown' to 'known'. */
export const JUDGMENT_ELEVATION_THRESHOLD = 0.20;

/** Max number of verified identities that contribute to the pairing score. */
const MAX_PAIRING_IDENTITIES = 3;

export interface ConfidenceInput {
  inboundMessageCount: number;
  outboundMessageCount: number;
  lastSeenAt: Date | null;
  tier: ContactTier;
  verifiedIdentityCount: number;
  hasCeoStatedIdentity: boolean;
  /** Current time — injected for testability. */
  now: Date;
}

/**
 * Compute contact confidence from stored stats and identity data.
 *
 * Formula:
 *   interactionScore = min(totalMessages / SATURATION, 1.0) * W_INTERACTION
 *   recencyScore     = lastSeenAt ? exp(-daysSince / HALF_LIFE) * W_RECENCY : 0
 *   verificationScore = grantBoost + manualBoost + pairingBoost
 *   confidence       = clamp(interaction + recency + verification, 0.0, 1.0)
 */
export function computeConfidence(input: ConfidenceInput): number {
  const {
    inboundMessageCount,
    outboundMessageCount,
    lastSeenAt,
    tier,
    verifiedIdentityCount,
    hasCeoStatedIdentity,
    now,
  } = input;

  // Interaction score: message volume with saturation
  const totalMessages = inboundMessageCount + outboundMessageCount;
  const interactionScore = Math.min(totalMessages / SATURATION, 1.0) * W_INTERACTION;

  // Recency score: exponential decay from last seen timestamp
  let recencyScore = 0;
  if (lastSeenAt) {
    const daysSinceLastSeen = (now.getTime() - lastSeenAt.getTime()) / (1000 * 60 * 60 * 24);
    recencyScore = Math.exp(-daysSinceLastSeen / RECENCY_HALF_LIFE_DAYS) * W_RECENCY;
  }

  // Verification score: discrete boosts from CEO actions and identity pairings.
  // Only trusted/principal tier earns the grant boost — those contacts have an
  // explicit CEO trust grant. known/unknown/blocked are neutral or restrictive.
  const grantBoost = meetsMinimumTier(tier, 'trusted') ? GRANT_BOOST : 0;
  const manualBoost = hasCeoStatedIdentity ? MANUAL_BOOST : 0;
  const pairingBoost =
    (Math.min(verifiedIdentityCount, MAX_PAIRING_IDENTITIES) / MAX_PAIRING_IDENTITIES) * PAIRING_BOOST;
  const verificationScore = grantBoost + manualBoost + pairingBoost;

  // Clamp to [0.0, 1.0]
  const raw = interactionScore + recencyScore + verificationScore;
  return Math.max(0.0, Math.min(1.0, raw));
}
