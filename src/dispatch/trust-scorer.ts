// src/dispatch/trust-scorer.ts
//
// Pure trust score computation. No I/O — takes resolved contact data and scan
// results, returns a single float in [0.0, 1.0].
//
// Formula: (channelWeight × weights.channelWeight) + (contactConfidence × weights.contactWeight)
//          − (injectionRiskScore × weights.maxRiskPenalty), clamped to [0.0, 1.0]
//
// The per-contact tier, when set, can override the channel trust weight for the
// channel weight calculation. trusted/principal contacts get a high-equivalent (1.0)
// override; known contacts get a medium-equivalent (0.6) override; unknown/blocked
// contacts and null use only the channel floor.

import type { ContactTier, TrustLevel } from '../contacts/types.js';

// Normalized weight per trust level — used to convert enum → float for the formula.
// 'ceo' is treated identically to 'high' for scoring (maximally trusted channel weight).
const CHANNEL_TRUST_NORMALIZED: Record<TrustLevel, number> = {
  ceo: 1.0,
  high: 1.0,
  medium: 0.6,
  low: 0.3,
};

// Tier-derived channel weight override. trusted/principal elevate to high-equivalent;
// known elevates to medium-equivalent; unknown/blocked use the channel floor (no entry here).
const TIER_CHANNEL_WEIGHT_OVERRIDE: Partial<Record<ContactTier, number>> = {
  principal: 1.0,
  trusted:   1.0,
  known:     0.6,
  // unknown and blocked: no entry — channel floor applies
};

export interface TrustScorerWeights {
  /** Weight applied to the channel trust component. Default: 0.4 */
  channelWeight: number;
  /** Weight applied to the contact confidence component. Default: 0.4 */
  contactWeight: number;
  /** Maximum penalty subtracted for injection risk. Default: 0.2 */
  maxRiskPenalty: number;
}

export const DEFAULT_TRUST_WEIGHTS: TrustScorerWeights = {
  channelWeight: 0.4,
  contactWeight: 0.4,
  maxRiskPenalty: 0.2,
};

export interface ComputeTrustScoreInput {
  /** Trust level of the originating channel (from channel-trust.yaml). */
  channelTrustLevel: TrustLevel;
  /** Accumulated contact confidence (0.0–1.0). 0.0 for unknown senders. */
  contactConfidence: number;
  /** Injection risk score from InboundScanner (0.0–1.0). 0.0 if scanner not available. */
  injectionRiskScore: number;
  /** Contact tier from DB. When non-null and trusted/principal/known, overrides the
   *  channel weight for the channel component calculation. unknown/blocked use channel floor. */
  tier: ContactTier | null;
  /** Configurable scoring weights. */
  weights: TrustScorerWeights;
}

/**
 * Compute the message trust score for a single inbound message.
 *
 * Returns a float in [0.0, 1.0]. Higher = more trustworthy.
 */
export function computeTrustScore(input: ComputeTrustScoreInput): number {
  const { channelTrustLevel, contactConfidence, injectionRiskScore, tier, weights } = input;

  // Determine the channel normalized weight. Use the tier-derived override when set
  // (trusted/principal → 1.0, known → 0.6); otherwise use the channel trust level.
  const tierOverride = tier !== null ? TIER_CHANNEL_WEIGHT_OVERRIDE[tier] : undefined;
  const channelNormalized =
    tierOverride !== undefined ? tierOverride : CHANNEL_TRUST_NORMALIZED[channelTrustLevel];

  // Guard against unexpected trust level values (e.g. a future DB value that bypasses
  // the CHECK constraint). An undefined lookup produces NaN which propagates silently.
  if (channelNormalized === undefined) {
    throw new Error(`computeTrustScore: unknown channel trust level '${channelTrustLevel}'`);
  }

  const channelComponent = channelNormalized * weights.channelWeight;
  const contactComponent = contactConfidence * weights.contactWeight;
  const riskPenalty = injectionRiskScore * weights.maxRiskPenalty;

  const raw = channelComponent + contactComponent - riskPenalty;

  // Clamp to [0.0, 1.0]
  return Math.max(0.0, Math.min(1.0, raw));
}
