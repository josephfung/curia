// src/dispatch/trust-scorer.ts
//
// Pure trust score computation. No I/O — takes resolved contact data and scan
// results, returns a single float in [0.0, 1.0].
//
// Formula: (channelWeight × weights.channelWeight) + (contactConfidence × weights.contactWeight)
//          − (injectionRiskScore × weights.maxRiskPenalty), clamped to [0.0, 1.0]
//
// The per-contact trust_level override, when set, replaces the channel trust level
// for the channel weight calculation. This allows the CEO to elevate or restrict a
// specific contact regardless of what channel they're on.

import type { TrustLevel } from '../contacts/types.js';

// Normalized weight per trust level — used to convert enum → float for the formula.
const CHANNEL_TRUST_NORMALIZED: Record<TrustLevel, number> = {
  high: 1.0,
  medium: 0.6,
  low: 0.3,
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
  /** Per-contact trust_level override from DB. When non-null, replaces channelTrustLevel
   *  for the channel weight calculation. */
  trustLevel: TrustLevel | null;
  /** Configurable scoring weights. */
  weights: TrustScorerWeights;
}

/**
 * Compute the message trust score for a single inbound message.
 *
 * Returns a float in [0.0, 1.0]. Higher = more trustworthy.
 */
export function computeTrustScore(input: ComputeTrustScoreInput): number {
  const { channelTrustLevel, contactConfidence, injectionRiskScore, trustLevel, weights } = input;

  // Use per-contact override if set; otherwise use channel trust level.
  const effectiveTrustLevel = trustLevel ?? channelTrustLevel;
  const channelNormalized = CHANNEL_TRUST_NORMALIZED[effectiveTrustLevel];

  // Guard against unexpected trust level values (e.g. a future DB value that bypasses
  // the CHECK constraint). An undefined lookup produces NaN which propagates silently.
  if (channelNormalized === undefined) {
    throw new Error(`computeTrustScore: unknown trust level '${effectiveTrustLevel}'`);
  }

  const channelComponent = channelNormalized * weights.channelWeight;
  const contactComponent = contactConfidence * weights.contactWeight;
  const riskPenalty = injectionRiskScore * weights.maxRiskPenalty;

  const raw = channelComponent + contactComponent - riskPenalty;

  // Clamp to [0.0, 1.0]
  return Math.max(0.0, Math.min(1.0, raw));
}
