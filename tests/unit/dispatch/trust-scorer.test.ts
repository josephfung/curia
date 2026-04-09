import { describe, it, expect } from 'vitest';
import { computeTrustScore, DEFAULT_TRUST_WEIGHTS } from '../../../src/dispatch/trust-scorer.js';

describe('computeTrustScore', () => {
  const weights = DEFAULT_TRUST_WEIGHTS;

  it('known high-trust sender, no risk → near 0.8', () => {
    // channelWeight=1.0*0.4=0.4, contactConfidence=1.0*0.4=0.4, penalty=0 → 0.8
    const score = computeTrustScore({
      channelTrustLevel: 'high',
      contactConfidence: 1.0,
      injectionRiskScore: 0,
      trustLevel: null,
      weights,
    });
    expect(score).toBeCloseTo(0.8);
  });

  it('unknown sender via email, no risk → 0.12', () => {
    // channelWeight=0.3*0.4=0.12, contactConfidence=0.0*0.4=0, penalty=0 → 0.12
    const score = computeTrustScore({
      channelTrustLevel: 'low',
      contactConfidence: 0.0,
      injectionRiskScore: 0,
      trustLevel: null,
      weights,
    });
    expect(score).toBeCloseTo(0.12);
  });

  it('medium channel, partial confidence, no risk', () => {
    // channelWeight=0.6*0.4=0.24, contactConfidence=0.5*0.4=0.20, penalty=0 → 0.44
    const score = computeTrustScore({
      channelTrustLevel: 'medium',
      contactConfidence: 0.5,
      injectionRiskScore: 0,
      trustLevel: null,
      weights,
    });
    expect(score).toBeCloseTo(0.44);
  });

  it('per-contact trust_level override replaces channel weight', () => {
    // trustLevel='high' → channelWeight=1.0, overrides 'low' channel
    // 1.0*0.4 + 0.5*0.4 = 0.60
    const score = computeTrustScore({
      channelTrustLevel: 'low',
      contactConfidence: 0.5,
      injectionRiskScore: 0,
      trustLevel: 'high',
      weights,
    });
    expect(score).toBeCloseTo(0.60);
  });

  it('injection risk reduces score', () => {
    // high channel, full confidence, riskScore=1.0 → 0.8 - 0.2 = 0.6
    const score = computeTrustScore({
      channelTrustLevel: 'high',
      contactConfidence: 1.0,
      injectionRiskScore: 1.0,
      trustLevel: null,
      weights,
    });
    expect(score).toBeCloseTo(0.6);
  });

  it('score is clamped to 0.0 minimum', () => {
    // Worst case: low channel, zero confidence, max risk
    const score = computeTrustScore({
      channelTrustLevel: 'low',
      contactConfidence: 0.0,
      injectionRiskScore: 1.0,
      trustLevel: null,
      weights,
    });
    expect(score).toBe(0.0);
  });

  it('score is clamped to 1.0 maximum', () => {
    // Even if weights somehow exceed 1.0, output is clamped
    const score = computeTrustScore({
      channelTrustLevel: 'high',
      contactConfidence: 1.0,
      injectionRiskScore: -1.0, // hypothetical negative penalty
      trustLevel: null,
      weights: { channelWeight: 0.6, contactWeight: 0.6, maxRiskPenalty: 0.2 },
    });
    expect(score).toBe(1.0);
  });

  it('partial injection risk applies proportional penalty', () => {
    // high channel, full confidence, riskScore=0.5 → 0.8 - 0.1 = 0.7
    const score = computeTrustScore({
      channelTrustLevel: 'high',
      contactConfidence: 1.0,
      injectionRiskScore: 0.5,
      trustLevel: null,
      weights,
    });
    expect(score).toBeCloseTo(0.7);
  });

  it('respects custom weight configuration', () => {
    const customWeights = { channelWeight: 0.5, contactWeight: 0.5, maxRiskPenalty: 0.1 };
    // high channel: 1.0*0.5=0.5, full confidence: 1.0*0.5=0.5, no risk → 1.0 (clamped)
    const score = computeTrustScore({
      channelTrustLevel: 'high',
      contactConfidence: 1.0,
      injectionRiskScore: 0,
      trustLevel: null,
      weights: customWeights,
    });
    expect(score).toBe(1.0);
  });
});
